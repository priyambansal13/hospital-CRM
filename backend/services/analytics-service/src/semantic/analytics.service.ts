import { Injectable } from '@nestjs/common';
import { branchesFor, EntitlementsClient } from '@mc/entitlements-sdk';
import { DomainError } from '@mc/nest-common';
import { type Actor, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { compile, type Dimension, dimensionsOf, DIMENSION_LABELS, DIMENSIONS, fill, labelOf, METRICS, MetricError, type MetricKey, type MetricQuery } from './metrics.js';

export const PERMISSION = 'analytics:read:branch';
const KPIS: MetricKey[] = ['appointments', 'completed_visits', 'no_show_rate', 'cancellation_rate', 'utilisation', 'revenue', 'lab_orders', 'lab_tat_hours', 'new_patients'];

export interface MetricResult {
  metric: MetricKey; label: string; unit: string; from: string; to: string; groupBy: Dimension | null; groupLabel: string | null;
  value: number | null; rows: { key: string | null; label: string; value: number | null }[];
}

const num = (v: unknown) => (v == null ? null : Math.round(Number(v) * 10) / 10);
const shift = (d: string, days: number) => new Date(Date.parse(`${d}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** Runs semantic-layer queries for a person: always within the branches they may see. */
@Injectable()
export class AnalyticsService {
  constructor(private readonly db: TenantDbRouter, private readonly entitlements: EntitlementsClient) {}

  async branchesOf(actor: Actor) {
    return branchesFor(await this.entitlements.capabilities(TenantContext.require().id, actor), PERMISSION);
  }

  catalog() {
    return {
      metrics: (Object.keys(METRICS) as MetricKey[]).map((k) => ({ key: k, label: METRICS[k].label, description: METRICS[k].description, unit: METRICS[k].unit, better: METRICS[k].better, dimensions: dimensionsOf(k) })),
      dimensions: DIMENSIONS.map((d) => ({ key: d, label: DIMENSION_LABELS[d] })),
    };
  }

  async query(actor: Actor, q: MetricQuery): Promise<MetricResult> {
    return this.run(q, await this.branchesOf(actor));
  }

  async run(q: MetricQuery, branches: string[] | null): Promise<MetricResult> {
    let sql: { sql: string; args: unknown[] };
    try {
      sql = compile(q, branches);
    } catch (e) {
      if (e instanceof MetricError) throw new DomainError(e.code === 'HOSPITAL_WIDE_ONLY' ? 403 : 422, e.code, e.message);
      throw e;
    }
    const { rows } = await this.db.query(sql.sql, sql.args);
    const m = METRICS[q.metric];
    if (!q.groupBy) {
      return { metric: q.metric, label: m.label, unit: m.unit, from: q.from, to: q.to, groupBy: null, groupLabel: null, value: num(rows[0]?.v) ?? (m.unit === 'count' || m.unit === 'inr' ? 0 : null), rows: [] };
    }
    const names = await this.names(q.groupBy);
    const filled = fill(q, rows.map((r) => ({ key: r.k as string, value: num(r.v) })));
    return {
      metric: q.metric, label: m.label, unit: m.unit, from: q.from, to: q.to, groupBy: q.groupBy, groupLabel: DIMENSION_LABELS[q.groupBy],
      value: null, rows: filled.map((r) => ({ key: r.key, label: labelOf(q.groupBy, r.key, names), value: r.value })),
    };
  }

  private async names(dim: Dimension): Promise<Map<string, string>> {
    const table = dim === 'branch' ? 'SELECT id::text k, name FROM dim_branches' : dim === 'doctor' ? 'SELECT id::text k, name FROM dim_doctors' : dim === 'specialty' ? 'SELECT code k, name FROM dim_specialties' : null;
    if (!table) return new Map();
    return new Map((await this.db.query(table)).rows.map((r) => [r.k as string, r.name as string]));
  }

  /** Headline numbers for a period and the same-length period before it (dashboard tiles). */
  async summary(actor: Actor, from: string, to: string, branchId?: string) {
    const branches = await this.branchesOf(actor);
    const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
    const prev = { from: shift(from, -days), to: shift(from, -1) };
    const kpis = KPIS.filter((k) => branches === null || METRICS[k].fact !== 'patients').filter((k) => !branchId || METRICS[k].fact !== 'patients');
    const out = await Promise.all(kpis.map(async (k) => {
      const base = { metric: k, filters: branchId ? { branchId } : {}, limit: 50 };
      const [now, before] = await Promise.all([this.run({ ...base, from, to }, branches), this.run({ ...base, ...prev }, branches)]);
      return { metric: k, label: METRICS[k].label, unit: METRICS[k].unit, better: METRICS[k].better, value: now.value, previous: before.value };
    }));
    return { from, to, previous: prev, kpis: out, asOf: await this.asOf() };
  }

  async asOf() {
    const { rows: [r] } = await this.db.query(`SELECT greatest((SELECT max(event_at) FROM fact_appointments), (SELECT max(event_at) FROM fact_lab_orders), (SELECT max(at) FROM fact_payments)) t`);
    const { rows: loads } = await this.db.query('SELECT source, status, rows, finished_at, error FROM loads ORDER BY source');
    return { lastEventAt: r?.t ?? null, loads: loads.map((l) => ({ source: l.source, status: l.status, rows: l.rows, finishedAt: l.finished_at, error: l.error })) };
  }

  /** The same query as a CSV file (label, value). */
  async csv(actor: Actor, q: MetricQuery) {
    const r = await this.query(actor, q);
    const cell = (v: unknown) => {
      if (typeof v === 'number') return String(v);
      const s = v == null ? '' : String(v);
      // neutralise spreadsheet formulas and quote
      return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
    };
    const head = [r.groupLabel ?? 'Period', `${r.label} (${r.unit})`];
    const lines = r.groupBy ? r.rows.map((x) => [x.label, x.value]) : [[`${r.from} to ${r.to}`, r.value]];
    return `${[head, ...lines].map((l) => l.map(cell).join(',')).join('\r\n')}\r\n`;
  }
}
