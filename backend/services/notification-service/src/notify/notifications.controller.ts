import { Body, Controller, Get, Param, Put, Query } from '@nestjs/common';
import { AdminAudited, CurrentActor, forbidden, notFound, parse } from '@mc/nest-common';
import { RequireModule, RequirePermission } from '@mc/entitlements-sdk';
import { type Actor, TenantDbRouter } from '@mc/tenancy';
import { z } from 'zod';

const Prefs = z.object({ smsEnabled: z.boolean(), emailEnabled: z.boolean(), language: z.enum(['en', 'hi']) });
const TemplateUpdate = z.object({ subject: z.string().trim().max(200).nullable().optional(), body: z.string().trim().min(5).max(2000), active: z.boolean().default(true),
  /** SMS (A-2): the provider's id of the DLT-registered template, and the DLT template id (for the record) */
  providerTemplateId: z.string().trim().max(60).nullable().optional(),
  dltTemplateId: z.string().trim().regex(/^\d{10,25}$/, 'DLT template ids are digits').nullable().optional(),
});
const ListQuery = z.object({ status: z.enum(['SCHEDULED', 'SENT', 'FAILED', 'SKIPPED', 'CANCELLED']).optional(), limit: z.coerce.number().int().min(1).max(200).default(100) });

/** Mask phone numbers and emails in staff views: +91******3210, a***@example.com */
export const mask = (to: string | null) => !to ? null : to.includes('@') ? to.replace(/^(.).*?(@.*)$/, '$1***$2') : to.replace(/^(\+\d{2})\d+(\d{4})$/, '$1******$2');

@Controller('v1')
@RequireModule('core')
export class NotificationsController {
  constructor(private readonly db: TenantDbRouter) {}

  @Get('me/notification-preferences')
  @RequirePermission('notification:manage:own')
  async prefs(@CurrentActor() actor: Actor) {
    if (actor.kind !== 'patient') throw forbidden('PATIENTS_ONLY', 'patients only');
    const { rows } = await this.db.query('SELECT phone, email, sms_enabled, email_enabled, language FROM contacts WHERE person_id = $1', [actor.id]);
    const r = rows[0];
    return { phone: mask(r?.phone ?? null), email: r?.email ?? null, smsEnabled: r?.sms_enabled ?? true, emailEnabled: r?.email_enabled ?? true, language: r?.language ?? 'en' };
  }

  @Put('me/notification-preferences')
  @RequirePermission('notification:manage:own')
  async setPrefs(@Body() body: unknown, @CurrentActor() actor: Actor) {
    if (actor.kind !== 'patient') throw forbidden('PATIENTS_ONLY', 'patients only');
    const p = parse(Prefs, body);
    await this.db.query(`INSERT INTO contacts (person_id, sms_enabled, email_enabled, language) VALUES ($1,$2,$3,$4)
      ON CONFLICT (person_id) DO UPDATE SET sms_enabled = $2, email_enabled = $3, language = $4, updated_at = now()`, [actor.id, p.smsEnabled, p.emailEnabled, p.language]);
    return this.prefs(actor);
  }

  /** Delivery log for the hospital (contact details masked). */
  @Get('notifications')
  @RequirePermission('notification:read:tenant')
  async list(@Query() q: unknown) {
    const f = parse(ListQuery, q);
    const { rows } = await this.db.query(
      `SELECT id, channel, template_key, status, send_at, sent_at, attempts, to_address, last_error, vars->>'appointmentNo' AS appointment_no, vars->>'patientName' AS patient_name
       FROM notifications ${f.status ? 'WHERE status = $2' : ''}
       -- what's coming up next for "scheduled"; otherwise the most recent activity first
       ORDER BY ${f.status === 'SCHEDULED' ? 'send_at ASC' : 'coalesce(sent_at, created_at) DESC, send_at DESC'} LIMIT $1`,
      f.status ? [f.limit, f.status] : [f.limit],
    );
    return rows.map((r) => ({ id: r.id, channel: r.channel, template: r.template_key, status: r.status, sendAt: r.send_at, sentAt: r.sent_at, attempts: r.attempts, to: mask(r.to_address), error: r.last_error, appointmentNo: r.appointment_no, patientName: r.patient_name }));
  }

  @Get('notification-templates')
  @RequirePermission('notification:manage:tenant')
  async templates() {
    const { rows } = await this.db.query('SELECT id, key, channel, language, subject, body, active, updated_at, provider_template_id, dlt_template_id FROM templates ORDER BY key, channel, language');
    return rows.map((r) => ({ id: r.id, key: r.key, channel: r.channel, language: r.language, subject: r.subject, body: r.body, active: r.active, updatedAt: r.updated_at, providerTemplateId: r.provider_template_id, dltTemplateId: r.dlt_template_id }));
  }

  @Put('notification-templates/:id')
  @AdminAudited('TEMPLATE')
  @RequirePermission('notification:manage:tenant')
  async updateTemplate(@Param('id') id: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    if (!z.uuid().safeParse(id).success) throw notFound('template');
    const t = parse(TemplateUpdate, body);
    const { rows } = await this.db.query(
      `UPDATE templates SET subject = CASE WHEN channel = 'EMAIL' THEN coalesce($2, subject) ELSE NULL END, body = $3, active = $4, updated_by = $5, updated_at = now(),
         provider_template_id = CASE WHEN channel = 'SMS' AND $6::boolean THEN $7 ELSE provider_template_id END,
         dlt_template_id = CASE WHEN channel = 'SMS' AND $8::boolean THEN $9 ELSE dlt_template_id END
       WHERE id = $1 RETURNING id, key, channel, language, subject, body, active, updated_at, provider_template_id, dlt_template_id`,
      [id, t.subject ?? null, t.body, t.active, actor.id, t.providerTemplateId !== undefined, t.providerTemplateId ?? null, t.dltTemplateId !== undefined, t.dltTemplateId ?? null],
    );
    if (!rows[0]) throw notFound('template');
    const r = rows[0];
    return { id: r.id, key: r.key, channel: r.channel, language: r.language, subject: r.subject, body: r.body, active: r.active, updatedAt: r.updated_at, providerTemplateId: r.provider_template_id, dltTemplateId: r.dlt_template_id };
  }
}
