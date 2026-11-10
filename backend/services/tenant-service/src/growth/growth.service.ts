import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventTypes, type StaffNotice, Topics } from '@mc/contracts';
import { addToOutbox, envelope, withTx } from '@mc/tenancy';
import { CONTROL_DB, DomainError, isDev, notFound, REDIS, type Redis } from '@mc/nest-common';
import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { CatalogRepo } from '../catalog/catalog.repo.js';
import { type Attribution, channel, stored } from './attribution.js';

export type ConversionKind = 'LEAD' | 'SIGNUP' | 'READY' | 'PAID';
export interface LeadInput { name: string; email: string; phone: string | null; hospitalName: string; city: string | null; segment: string; doctors: number | null; message: string | null; attribution: Attribution }
type Row = Record<string, unknown> & { attribution: Record<string, string> };

export const emailHash = (email: string) => createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
const LEAD_STATUSES = ['NEW', 'CONTACTED', 'DEMO_DONE', 'WON', 'LOST'] as const;
/** Names the conversions get on ad platforms (create conversion actions with these names in Google Ads). */
const GOOGLE_NAME: Record<ConversionKind, string> = { LEAD: 'MediCare demo request', SIGNUP: 'MediCare signup confirmed', READY: 'MediCare hospital ready', PAID: 'MediCare first payment' };
const META_EVENT: Record<ConversionKind, string> = { LEAD: 'Lead', SIGNUP: 'CompleteRegistration', READY: 'StartTrial', PAID: 'Purchase' };
const csv = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
/** Google's offline-conversion time format, in India time. */
const istTime = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 19).replace('T', ' ');

/**
 * MediCare's own funnel (docs/SEO-AND-ADS.md §3.5): demo requests (leads), where signups came from, and the
 * conversions reported back to ad platforms. Ad platforms only ever get a hashed e-mail, and only for visitors who
 * accepted ad cookies; nothing from a hospital's patient pages is ever recorded here.
 */
@Injectable()
export class GrowthService {
  private readonly log = new Logger('Growth');
  constructor(@Inject(CONTROL_DB) private readonly db: pg.Pool, @Inject(REDIS) private readonly redis: Redis, private readonly catalog: CatalogRepo) {}

  private async rateLimit(key: string, max: number) {
    const n = await this.redis.incr(`lead:rl:${key}`);
    if (n === 1) await this.redis.expire(`lead:rl:${key}`, 3600);
    if (n > max) throw new DomainError(429, 'TOO_MANY_REQUESTS', 'too many requests from here: try again in an hour');
  }

  /** Records a funnel step once (the same signup is never counted twice). */
  async record(c: pg.Pool | pg.PoolClient, kind: ConversionKind, refId: string, email: string, attribution: Record<string, string>, adsConsent: boolean, value: number | null = null, at: Date | null = null) {
    await c.query(
      `INSERT INTO conversions (id, kind, ref_id, email_sha256, attribution, ads_consent, value, occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7, coalesce($8, now())) ON CONFLICT (kind, ref_id) DO NOTHING`,
      [randomUUID(), kind, refId, emailHash(email), JSON.stringify(attribution), adsConsent, value, at]);
  }

  /** "Book a demo": the lead, its LEAD conversion and a notice to MediCare's sales/support team, together. */
  async createLead(input: LeadInput, ip: string | null) {
    await this.rateLimit(`email:${input.email.toLowerCase()}`, 3);
    if (ip) await this.rateLimit(`ip:${ip}`, Number(process.env.LEAD_IP_LIMIT ?? (isDev() ? 200 : 20)));
    const { attribution, adsConsent } = stored(input.attribution);
    const id = randomUUID();
    const hq = await this.catalog.findBySlug(process.env.HQ_SLUG ?? 'medicare');
    await withTx(this.db, async (c) => {
      await c.query(
        `INSERT INTO leads (id, name, email, phone, hospital_name, city, segment, doctors, message, attribution, ads_consent, ip) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [id, input.name, input.email.toLowerCase(), input.phone, input.hospitalName, input.city, input.segment, input.doctors, input.message, JSON.stringify(attribution), adsConsent, ip]);
      await this.record(c, 'LEAD', id, input.email, attribution, adsConsent);
      if (hq) {
        const ch = channel(attribution);
        const n: StaffNotice = {
          permission: 'customer:manage:tenant', subject: `Demo request: ${input.hospitalName}${input.city ? `, ${input.city}` : ''}`,
          message: `${input.name} <${input.email}>${input.phone ? `, ${input.phone}` : ''} asked for a demo (${input.segment.toLowerCase()}${input.doctors != null ? `, ${input.doctors} doctors` : ''}; came from ${ch.source} / ${ch.campaign}).`,
          linkPath: '/platform/growth', dedupe: `lead:${id}`,
        };
        await addToOutbox(c, Topics.tenant, hq.id, envelope(EventTypes.staffNotice, n, { tenantId: hq.id }));
      }
    });
    this.log.log(`demo request ${id} (${input.segment})`);
    return { id, status: 'NEW' };
  }

  async leads(status?: string) {
    const { rows } = await this.db.query(
      `SELECT * FROM leads WHERE ($1::text IS NULL OR status = $1) ORDER BY created_at DESC LIMIT 200`, [status ?? null]);
    return rows.map((r) => ({
      id: r.id, name: r.name, email: r.email, phone: r.phone, hospitalName: r.hospital_name, city: r.city, segment: r.segment, doctors: r.doctors,
      message: r.message, status: r.status, note: r.note, channel: channel(r.attribution), landing: r.attribution.landing ?? null, createdAt: r.created_at, updatedAt: r.updated_at, updatedBy: r.updated_by,
    }));
  }

  async updateLead(id: string, patch: { status?: (typeof LEAD_STATUSES)[number]; note?: string | null }, by: string) {
    const { rows: [r] } = await this.db.query(
      `UPDATE leads SET status = coalesce($2, status), note = CASE WHEN $3::boolean THEN $4 ELSE note END, updated_at = now(), updated_by = $5 WHERE id = $1 RETURNING id, status, note`,
      [id, patch.status ?? null, patch.note !== undefined, patch.note ?? null, by]);
    if (!r) throw notFound('lead');
    return r;
  }

  /**
   * The funnel by channel over the last `days`: demo requests; signups started, confirmed, ready, and paying (first
   * paid invoice). Grouped by source / medium / campaign from the stored attribution.
   */
  async funnel(days: number) {
    const [leads, signups] = await Promise.all([
      this.db.query<Row>(`SELECT attribution, status FROM leads WHERE created_at > now() - make_interval(days => $1)`, [days]),
      this.db.query<Row>(
        `SELECT s.attribution, s.verified_at IS NOT NULL AS confirmed, s.status = 'READY' AS ready, p.ref_id IS NOT NULL AS paid
         FROM signups s LEFT JOIN conversions p ON p.kind = 'PAID' AND p.ref_id = s.id
         WHERE s.created_at > now() - make_interval(days => $1)`, [days]),
    ]);
    type Line = { source: string; medium: string; campaign: string; leads: number; leadsWon: number; signups: number; confirmed: number; ready: number; paid: number };
    const lines = new Map<string, Line>();
    const line = (a: Record<string, string>) => {
      const ch = channel(a);
      const k = `${ch.source}|${ch.medium}|${ch.campaign}`;
      if (!lines.has(k)) lines.set(k, { ...ch, leads: 0, leadsWon: 0, signups: 0, confirmed: 0, ready: 0, paid: 0 });
      return lines.get(k)!;
    };
    for (const r of leads.rows) { const l = line(r.attribution); l.leads++; if (r.status === 'WON') l.leadsWon++; }
    for (const r of signups.rows) { const l = line(r.attribution); l.signups++; if (r.confirmed) l.confirmed++; if (r.ready) l.ready++; if (r.paid) l.paid++; }
    const rows = [...lines.values()].sort((a, b) => b.paid - a.paid || b.ready - a.ready || b.signups + b.leads - (a.signups + a.leads));
    const total = rows.reduce((t, r) => ({ leads: t.leads + r.leads, leadsWon: t.leadsWon + r.leadsWon, signups: t.signups + r.signups, confirmed: t.confirmed + r.confirmed, ready: t.ready + r.ready, paid: t.paid + r.paid }), { leads: 0, leadsWon: 0, signups: 0, confirmed: 0, ready: 0, paid: 0 });
    return { days, rows, total, ads: await this.adsStatus() };
  }

  async adsStatus() {
    const { rows: [r] } = await this.db.query(
      `SELECT count(*) FILTER (WHERE ads_consent)::int consented, count(*)::int total,
              count(*) FILTER (WHERE ads_consent AND meta_sent_at IS NULL)::int meta_pending,
              (SELECT meta_error FROM conversions WHERE meta_error IS NOT NULL ORDER BY occurred_at DESC LIMIT 1) meta_error
       FROM conversions WHERE occurred_at > now() - interval '90 days'`);
    return { meta: { configured: !!(process.env.META_PIXEL_ID && process.env.META_CAPI_TOKEN), pending: r.meta_pending, lastError: r.meta_error }, conversions: r.total, withConsent: r.consented };
  }

  /**
   * Google Ads offline-conversion import (Tools → Conversions → Uploads): consented conversions with a click id or a
   * hashed e-mail (Enhanced Conversions for leads). Times are India time, as the Parameters line says.
   */
  async googleCsv(days: number) {
    const { rows } = await this.db.query(
      `SELECT kind, email_sha256, attribution, value, occurred_at FROM conversions WHERE ads_consent AND occurred_at > now() - make_interval(days => $1) ORDER BY occurred_at`, [days]);
    const lines = ['Parameters:TimeZone=Asia/Calcutta', 'Google Click ID,Email,Conversion Name,Conversion Time,Conversion Value,Conversion Currency'];
    for (const r of rows) lines.push([r.attribution.gclid ?? '', r.email_sha256, GOOGLE_NAME[r.kind as ConversionKind], istTime(r.occurred_at), r.value ?? '', r.value != null ? 'INR' : ''].map(csv).join(','));
    return `${lines.join('\n')}\n`;
  }

  /** Signups whose hospital has paid its first invoice since: record PAID (the job runs this). */
  async findPaid(svc: (path: string) => Promise<{ invoices: { total: number; paidAt: string | null }[] } | null>) {
    const { rows } = await this.db.query(
      `SELECT s.id, s.admin_email, s.attribution, s.ads_consent, s.tenant_id FROM signups s
       WHERE s.status = 'READY' AND s.tenant_id IS NOT NULL AND s.ready_at > now() - interval '400 days'
         AND NOT EXISTS (SELECT 1 FROM conversions p WHERE p.kind = 'PAID' AND p.ref_id = s.id)
       ORDER BY s.ready_at DESC LIMIT 200`);
    let found = 0;
    for (const s of rows) {
      const b = await svc(`/internal/tenants/${s.tenant_id}/billing`).catch(() => null);
      const first = b?.invoices.filter((i) => i.paidAt && i.total > 0).sort((x, y) => x.paidAt!.localeCompare(y.paidAt!))[0];
      if (!first) continue;
      await this.record(this.db, 'PAID', s.id, s.admin_email, s.attribution, s.ads_consent, first.total, new Date(first.paidAt!));
      found++;
    }
    return found;
  }

  /**
   * Meta's Conversions API, from the server: consented conversions only, the hashed e-mail and the click id, never
   * anything about a hospital's patients. Does nothing until META_PIXEL_ID and META_CAPI_TOKEN are set.
   */
  async sendMeta(fetchImpl: typeof fetch = fetch) {
    const pixel = process.env.META_PIXEL_ID;
    const token = process.env.META_CAPI_TOKEN;
    if (!pixel || !token) return { sent: 0, configured: false };
    const { rows } = await this.db.query(
      `SELECT id, kind, email_sha256, attribution, value, occurred_at FROM conversions WHERE ads_consent AND meta_sent_at IS NULL AND occurred_at > now() - interval '7 days' ORDER BY occurred_at LIMIT 50`);
    if (!rows.length) return { sent: 0, configured: true };
    const data = rows.map((r) => ({
      event_name: META_EVENT[r.kind as ConversionKind], event_time: Math.floor(new Date(r.occurred_at).getTime() / 1000), event_id: r.id, action_source: 'website',
      user_data: { em: [r.email_sha256], ...(r.attribution.fbclid ? { fbc: `fb.1.${new Date(r.occurred_at).getTime()}.${r.attribution.fbclid}` } : {}) },
      ...(r.value != null ? { custom_data: { value: Number(r.value), currency: 'INR' } } : {}),
    }));
    const ids = rows.map((r) => r.id);
    const res = await fetchImpl(`https://graph.facebook.com/${process.env.META_API_VERSION ?? 'v21.0'}/${encodeURIComponent(pixel)}/events?access_token=${encodeURIComponent(token)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data, ...(process.env.META_TEST_EVENT_CODE ? { test_event_code: process.env.META_TEST_EVENT_CODE } : {}) }), signal: AbortSignal.timeout(10_000),
    }).catch((e: Error) => ({ ok: false, status: 0, text: async () => e.message }));
    if (!res.ok) {
      const err = `${res.status}: ${(await res.text()).slice(0, 300)}`;
      await this.db.query('UPDATE conversions SET meta_error = $2 WHERE id = ANY($1)', [ids, err]);
      this.log.warn(`Meta conversions not sent: ${err}`);
      return { sent: 0, configured: true, error: err };
    }
    await this.db.query('UPDATE conversions SET meta_sent_at = now(), meta_error = NULL WHERE id = ANY($1)', [ids]);
    return { sent: rows.length, configured: true };
  }
}
