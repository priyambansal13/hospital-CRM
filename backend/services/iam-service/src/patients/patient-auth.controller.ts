import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { PhoneNumber } from '@mc/contracts';
import { CONTROL_DB, DomainError, parse, Public, REDIS, type Redis, TenantPublic } from '@mc/nest-common';
import { TenantContext, TenantDbRouter } from '@mc/tenancy';
import { createHash, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { SmsSender } from './sms.js';
import { TokenService } from './token.service.js';

const Phone = PhoneNumber;
const RequestOtp = z.object({ phone: Phone });
const VerifyOtp = z.object({ phone: Phone, code: z.string().regex(/^\d{6}$/) });
const Refresh = z.object({ refreshToken: z.string().min(20).max(200) });

const OTP_TTL_S = 300;
const MAX_ATTEMPTS = 5;
const MAX_SENDS_PER_10_MIN = 3;
const hash = (s: string) => createHash('sha256').update(s).digest();

@Controller()
export class PatientAuthController {
  constructor(
    private readonly tokens: TokenService,
    private readonly sms: SmsSender,
    private readonly db: TenantDbRouter,
    @Inject(CONTROL_DB) private readonly control: pg.Pool,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Get('patient-auth/jwks.json')
  @Public()
  jwks() {
    return this.tokens.jwks();
  }

  @Post('v1/auth/otp/request')
  @TenantPublic()
  @HttpCode(202)
  async request(@Body() body: unknown) {
    const { phone } = parse(RequestOtp, body);
    const t = TenantContext.require();
    const rl = `otp:rl:${t.id}:${phone}`;
    const sends = await this.redis.incr(rl);
    if (sends === 1) await this.redis.expire(rl, 600);
    if (sends > MAX_SENDS_PER_10_MIN) throw new DomainError(429, 'OTP_RATE_LIMITED', 'too many codes requested; try again later');
    const code = String(randomInt(100000, 1000000));
    await this.redis.set(`otp:${t.id}:${phone}`, JSON.stringify({ hash: hash(code).toString('hex'), attempts: 0 }), 'EX', OTP_TTL_S);
    await this.sms.send(phone, `${code} is your ${t.name} login code. It expires in 5 minutes. Do not share it.`, t, code);
    return { sent: true, expiresIn: OTP_TTL_S };
  }

  @Post('v1/auth/otp/verify')
  @TenantPublic()
  async verify(@Body() body: unknown) {
    const { phone, code } = parse(VerifyOtp, body);
    const t = TenantContext.require();
    const key = `otp:${t.id}:${phone}`;
    const raw = await this.redis.get(key);
    if (!raw) throw new DomainError(401, 'OTP_INVALID', 'code is wrong or expired');
    const rec = JSON.parse(raw) as { hash: string; attempts: number };
    if (rec.attempts >= MAX_ATTEMPTS) {
      await this.redis.del(key);
      throw new DomainError(429, 'OTP_LOCKED', 'too many wrong codes; request a new one');
    }
    if (!timingSafeEqual(Buffer.from(rec.hash, 'hex'), hash(code))) {
      await this.redis.set(key, JSON.stringify({ ...rec, attempts: rec.attempts + 1 }), 'KEEPTTL');
      throw new DomainError(401, 'OTP_INVALID', 'code is wrong or expired');
    }
    await this.redis.del(key);

    // one global person per phone; a separate account row in this hospital's own database
    const { rows } = await this.control.query(
      `INSERT INTO persons (id, phone) VALUES ($1, $2) ON CONFLICT (phone) DO UPDATE SET phone = EXCLUDED.phone RETURNING id`,
      [randomUUID(), phone],
    );
    const personId = rows[0].id as string;
    const { rows: acct } = await this.db.query(
      `INSERT INTO patient_accounts (person_id, phone) VALUES ($1, $2)
       ON CONFLICT (person_id) DO UPDATE SET last_login_at = now() RETURNING (xmax = 0) AS created`,
      [personId, phone],
    );
    return { ...(await this.tokens.issue(personId, t.id)), newAccount: acct[0].created };
  }

  @Post('v1/auth/refresh')
  @TenantPublic()
  async refresh(@Body() body: unknown) {
    const { refreshToken } = parse(Refresh, body);
    const out = await this.tokens.rotate(refreshToken, TenantContext.require().id);
    if (!out) throw new DomainError(401, 'REFRESH_INVALID', 'session expired; sign in again');
    return out;
  }

  @Post('v1/auth/logout')
  @TenantPublic()
  @HttpCode(204)
  async logout(@Body() body: unknown) {
    await this.tokens.revoke(parse(Refresh, body).refreshToken);
  }
}
