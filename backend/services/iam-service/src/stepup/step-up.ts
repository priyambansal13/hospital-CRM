import { Body, Controller, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { CurrentActor, DomainError, forbidden, Internal, notFound, parse, PLACEMENTS, REDIS, type Redis, smtpOptions } from '@mc/nest-common';
import { type Actor, type PlacementSource, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import nodemailer from 'nodemailer';
import { z } from 'zod';

/** What a step-up code may confirm (each a sensitive change). */
export const PURPOSES = { PAYOUT_ACCOUNT: 'change where patients\' payments are paid out' } as const;
const Purpose = z.enum(Object.keys(PURPOSES) as [keyof typeof PURPOSES]);
const TTL_S = 600;
const MAX_ATTEMPTS = 5;
const hash = (s: string) => createHash('sha256').update(s).digest();
const key = (tenantId: string, userId: string, purpose: string) => `stepup:${tenantId}:${userId}:${purpose}`;

/**
 * Step-up confirmation for sensitive changes (review B-5): a one-time code e-mailed to the staff member's own address,
 * valid 10 minutes and for one purpose. Proves the person at the keyboard also controls the account's mailbox, which
 * a stolen session alone does not. Other services check it through the internal verify route (which consumes it).
 */
@Controller()
export class StepUpController {
  private readonly mail = nodemailer.createTransport(smtpOptions());
  constructor(@Inject(REDIS) private readonly redis: Redis, private readonly db: TenantDbRouter, @Inject(PLACEMENTS) private readonly placements: PlacementSource) {}

  @Post('v1/me/step-up')
  @HttpCode(200)
  async send(@Body() body: unknown, @CurrentActor() actor: Actor) {
    if (actor.kind !== 'staff') throw forbidden('STAFF_ONLY', 'staff only');
    const { purpose } = parse(z.object({ purpose: Purpose }), body);
    const t = TenantContext.require();
    const { rows: [m] } = await this.db.query(`SELECT email, name FROM staff_members WHERE user_id = $1 AND status <> 'DISABLED'`, [actor.id]);
    if (!m) throw forbidden('STAFF_ONLY', 'staff only');
    const rl = `stepup-rl:${t.id}:${actor.id}`;
    const n = await this.redis.incr(rl);
    if (n === 1) await this.redis.expire(rl, 600);
    if (n > 5) throw new DomainError(429, 'TOO_MANY_CODES', 'too many codes asked for: wait 10 minutes');
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.redis.set(key(t.id, actor.id, purpose), JSON.stringify({ hash: hash(code).toString('hex'), attempts: 0 }), 'EX', TTL_S);
    await this.mail.sendMail({
      from: `security@${t.slug}.medicare.local`, to: m.email, subject: `Your confirmation code: ${code}`,
      text: `Hello ${m.name},\n\n${code} is your code to ${PURPOSES[purpose]} at ${t.name}. It is valid for 10 minutes.\n\nIf this was not you, do not share the code and tell your hospital admin: someone may be using your account.\n\nMediCare`,
    });
    return { sent: true, to: m.email.replace(/^(.).*(@.*)$/, '$1•••$2') };
  }

  /** Internal: is this the code the user was sent for this purpose? One use only. */
  @Post('internal/tenants/:tenantId/step-up/verify')
  @Internal()
  @HttpCode(200)
  async verify(@Param('tenantId') tenantId: string, @Body() body: unknown) {
    if (!z.uuid().safeParse(tenantId).success) throw notFound('tenant');
    await this.placements.get(tenantId);
    const v = parse(z.object({ userId: z.uuid(), purpose: Purpose, code: z.string().trim().regex(/^\d{6}$/, '6 digits') }), body);
    const k = key(tenantId, v.userId, v.purpose);
    const raw = await this.redis.get(k);
    if (!raw) throw new DomainError(422, 'STEP_UP_REQUIRED', 'ask for a confirmation code first (it is e-mailed to you)');
    const rec = JSON.parse(raw) as { hash: string; attempts: number };
    if (rec.attempts >= MAX_ATTEMPTS) { await this.redis.del(k); throw new DomainError(422, 'STEP_UP_REQUIRED', 'too many wrong codes: ask for a new one'); }
    if (!timingSafeEqual(Buffer.from(rec.hash, 'hex'), hash(v.code))) {
      await this.redis.set(k, JSON.stringify({ ...rec, attempts: rec.attempts + 1 }), 'KEEPTTL');
      throw new DomainError(422, 'WRONG_CODE', 'that code is not right');
    }
    await this.redis.del(k);
    return { ok: true };
  }
}
