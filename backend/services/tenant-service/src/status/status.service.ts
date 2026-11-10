import { Inject, Injectable } from '@nestjs/common';
import { CONTROL_DB, notFound } from '@mc/nest-common';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';

export type State = 'operational' | 'degraded' | 'partial_outage' | 'major_outage' | 'maintenance';
export type Impact = 'MINOR' | 'MAJOR' | 'CRITICAL' | 'MAINTENANCE';
export type IncidentStatus = 'SCHEDULED' | 'INVESTIGATING' | 'IDENTIFIED' | 'MONITORING' | 'RESOLVED';

/**
 * What hospitals and patients see as one thing, and the services behind it. A component is down when any of its
 * services can't serve (its readiness fails); degraded when one reports a shared dependency down (Redis: sign-in
 * codes, booking and payments refuse with 503, reading still works).
 */
export const COMPONENTS: { key: string; name: string; services: string[]; needsRedis?: boolean }[] = [
  { key: 'sites', name: 'Hospital websites and patient app', services: ['TENANT', 'PROVIDER'] },
  { key: 'sign-in', name: 'Sign-in (staff and patients)', services: ['IAM', 'ENTITLEMENT'], needsRedis: true },
  { key: 'booking', name: 'Appointments and front desk', services: ['SCHEDULING', 'PATIENT'], needsRedis: true },
  { key: 'records', name: 'Medical records and prescriptions', services: ['RECORDS', 'AUDIT'] },
  { key: 'lab', name: 'Lab tests and reports', services: ['DIAGNOSTICS'] },
  { key: 'payments', name: 'Payments and billing', services: ['BILLING', 'SUBSCRIPTION'], needsRedis: true },
  { key: 'notifications', name: 'SMS and e-mail messages', services: ['NOTIFICATION'] },
  { key: 'search', name: 'Doctor and test search', services: ['SEARCH'] },
  { key: 'assistant', name: 'AI assistant', services: ['ASSISTANT'] },
  { key: 'analytics', name: 'Analytics and integrations', services: ['ANALYTICS', 'INTEGRATION'] },
];
export const COMPONENT_KEYS = COMPONENTS.map((c) => c.key);
const RANK: Record<State, number> = { operational: 0, maintenance: 1, degraded: 2, partial_outage: 3, major_outage: 4 };
const FROM_IMPACT: Record<Impact, State> = { MINOR: 'degraded', MAJOR: 'partial_outage', CRITICAL: 'major_outage', MAINTENANCE: 'maintenance' };
const worst = (a: State, b: State) => (RANK[b] > RANK[a] ? b : a);

/**
 * The public status page and the console's incident list (docs/OPERATIONS.md §5). Health checks are cached for 30 s
 * so the page can be polled freely; nothing about any hospital or patient is ever on it.
 */
@Injectable()
export class StatusService {
  private health: { at: number; byService: Map<string, 'up' | 'degraded' | 'down'> } = { at: 0, byService: new Map() };

  constructor(@Inject(CONTROL_DB) private readonly db: pg.Pool) {}

  private async probe(): Promise<Map<string, 'up' | 'degraded' | 'down'>> {
    if (Date.now() - this.health.at < 30_000) return this.health.byService;
    const names = [...new Set(COMPONENTS.flatMap((c) => c.services))];
    const results = await Promise.all(names.map(async (n): Promise<[string, 'up' | 'degraded' | 'down']> => {
      const url = process.env[`SVC_URL_${n}`];
      if (!url) return [n, 'up']; // not deployed here: nothing to say
      const r = await fetch(`${url}/health/ready`, { signal: AbortSignal.timeout(2500) }).catch(() => null);
      if (!r || !r.ok) return [n, 'down'];
      const j = (await r.json().catch(() => ({}))) as { status?: string };
      return [n, j.status === 'degraded' ? 'degraded' : 'up'];
    }));
    this.health = { at: Date.now(), byService: new Map(results) };
    return this.health.byService;
  }

  private async incidents(sinceDays: number) {
    const { rows } = await this.db.query(
      `SELECT i.*, coalesce(json_agg(json_build_object('status', u.status, 'message', u.message, 'at', u.created_at) ORDER BY u.created_at DESC) FILTER (WHERE u.id IS NOT NULL), '[]') updates
       FROM status_incidents i LEFT JOIN status_updates u ON u.incident_id = i.id
       WHERE i.status <> 'RESOLVED' OR i.resolved_at > now() - make_interval(days => $1)
       GROUP BY i.id ORDER BY (i.status = 'RESOLVED'), i.starts_at DESC LIMIT 50`, [sinceDays]);
    return rows.map((r) => ({
      id: r.id, title: r.title, impact: r.impact as Impact, components: r.components as string[], status: r.status as IncidentStatus,
      startsAt: r.starts_at, endsAt: r.ends_at, resolvedAt: r.resolved_at, updatedAt: r.updated_at,
      updates: (r.updates as { status: string; message: string; at: string }[]),
    }));
  }

  /** The public view: each component's state, open incidents and the last 14 days' resolved ones. */
  async status() {
    const [health, incidents] = await Promise.all([this.probe(), this.incidents(14)]);
    const now = Date.now();
    const active = incidents.filter((i) => i.status !== 'RESOLVED' && (i.status !== 'SCHEDULED' || +new Date(i.startsAt) <= now));
    const components = COMPONENTS.map((c) => {
      const states = c.services.map((s) => health.get(s) ?? 'up');
      let state: State = states.includes('down') ? (states.every((x) => x === 'down') ? 'major_outage' : 'partial_outage') : states.includes('degraded') && c.needsRedis ? 'degraded' : 'operational';
      for (const i of active) if (i.components.includes(c.key)) state = worst(state, FROM_IMPACT[i.impact]);
      return { key: c.key, name: c.name, state };
    });
    const overall = components.reduce<State>((w, c) => worst(w, c.state), 'operational');
    return { updatedAt: new Date().toISOString(), overall, components, incidents };
  }

  async create(i: { title: string; impact: Impact; components: string[]; status: IncidentStatus; message: string; startsAt: string | null; endsAt: string | null }, by: string) {
    const id = randomUUID();
    const c = await this.db.connect();
    try {
      await c.query('BEGIN');
      await c.query(`INSERT INTO status_incidents (id, title, impact, components, status, starts_at, ends_at, created_by) VALUES ($1,$2,$3,$4,$5, coalesce($6, now()), $7, $8)`,
        [id, i.title, i.impact, i.components, i.status, i.startsAt, i.endsAt, by]);
      await c.query(`INSERT INTO status_updates (id, incident_id, status, message, created_by) VALUES ($1,$2,$3,$4,$5)`, [randomUUID(), id, i.status, i.message, by]);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
    this.health.at = 0;
    return { id };
  }

  async update(id: string, u: { status: IncidentStatus; message: string }, by: string) {
    const { rowCount } = await this.db.query(
      `UPDATE status_incidents SET status = $2, resolved_at = CASE WHEN $2 = 'RESOLVED' THEN now() ELSE NULL END, updated_at = now() WHERE id = $1`, [id, u.status]);
    if (!rowCount) throw notFound('incident');
    await this.db.query(`INSERT INTO status_updates (id, incident_id, status, message, created_by) VALUES ($1,$2,$3,$4,$5)`, [randomUUID(), id, u.status, u.message, by]);
    return { id, status: u.status };
  }

  /** The console: every incident of the last 90 days, with who posted each update. */
  async list() {
    return this.incidents(90);
  }
}
