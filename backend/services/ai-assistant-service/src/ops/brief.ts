import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { EventTypes, type OpsBrief, type TenantPlacement, Topics } from '@mc/contracts';
import { EntitlementsClient } from '@mc/entitlements-sdk';
import { dateOnly, notFound, PLACEMENTS } from '@mc/nest-common';
import { addToOutbox, envelope, type PlacementSource, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { randomUUID } from 'node:crypto';
import { devBrief as plainBrief } from '../llm/dev-ops.js';
import { LLM, type LlmClient } from '../llm/llm.js';
import { allowedNumbers, unknownNumbers } from './numbers.js';

const ANALYTICS = () => process.env.SVC_URL_ANALYTICS ?? 'http://localhost:4417';
const BRIEF_HOUR = Number(process.env.OPS_BRIEF_HOUR ?? 7);
export const BRIEF_PERMISSION = 'ops_brief:receive:branch';

export async function internalGet<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { 'x-internal-token': process.env.INTERNAL_API_TOKEN ?? '' }, signal: AbortSignal.timeout(20_000) });
  if (res.status === 404) throw notFound('branch');
  if (!res.ok) throw new Error(`${new URL(url).port} ${res.status}`);
  return (await res.json()) as T;
}

const SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string', description: 'one sentence, at most 25 words' },
    points: { type: 'array', items: { type: 'string' }, maxItems: 6, description: 'short sentences, most useful first' },
  },
  required: ['headline', 'points'],
};
const SYSTEM = [
  'You write the morning brief for a hospital branch\'s administrator from the facts given in <brief_facts> (JSON).',
  'Lead with what needs attention today (load against capacity, free doctors to fill, reports past their promised time, payments to check), then yesterday in one or two points.',
  'Use only the numbers in the facts, exactly as given; do not calculate new ones. No patient details exist in the facts; do not invent any. Plain English, no markdown.',
].join('\n');

/**
 * The morning brief per branch (docs/AI-AGENTS.md §6): facts from the analytics warehouse (de-identified), wording
 * from the model (number-checked like the Ops agent; else the plain wording), kept in ops_briefs and e-mailed to the
 * branch's brief readers (`ops_brief:receive:branch`) once a day from 7 a.m. branch time.
 */
@Injectable()
export class BriefService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('OpsBrief');
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly db: TenantDbRouter, @Inject(LLM) private readonly llm: LlmClient, private readonly entitlements: EntitlementsClient,
    @Inject(PLACEMENTS) private readonly placements: PlacementSource,
  ) {}

  onApplicationBootstrap() {
    if (process.env.MC_DISABLE_JOBS === 'true') return;
    this.timer = setInterval(() => void this.runAll().catch((e) => this.log.warn((e as Error).message)), Number(process.env.OPS_BRIEF_INTERVAL_MS ?? 600_000));
  }
  onApplicationShutdown() { if (this.timer) clearInterval(this.timer); }

  async enabled(tenantId: string, feature: string) {
    if ((await this.entitlements.moduleState(tenantId, 'ai_ops')) !== 'ACTIVE') return false;
    return (await this.entitlements.tenantFeatures(tenantId)).features[feature]?.enabled !== false;
  }

  async runAll() {
    for (const t of await this.placements.list()) {
      if (t.status !== 'ACTIVE' || !(await this.enabled(t.id, 'ai_ops.brief').catch(() => false))) continue;
      await this.runTenant(t).catch((e) => this.log.warn(`${t.slug}: ${(e as Error).message}`));
    }
  }

  /** Every branch that has reached `hour` local time and has no brief today gets one (and the e-mail). */
  async runTenant(t: TenantPlacement, hour = BRIEF_HOUR) {
    const branches = await internalGet<{ id: string; name: string; localHour: number; today: string }[]>(`${ANALYTICS()}/internal/tenants/${t.id}/analytics/branches`);
    let made = 0;
    for (const b of branches) {
      if (b.localHour < hour) continue;
      const exists = await TenantContext.run(t, () => this.db.query('SELECT 1 FROM ops_briefs WHERE branch_id = $1 AND day = $2', [b.id, b.today]));
      if (exists.rowCount) continue;
      await TenantContext.run(t, () => this.make(t, b.id, true));
      made++;
    }
    return made;
  }

  /** Write (or rewrite) today's brief for a branch; `email` sends it to the brief readers the first time only. */
  async make(t: TenantPlacement, branchId: string, email: boolean) {
    const facts = await internalGet<{ branchId: string; branchName: string; date: string } & Record<string, unknown>>(`${ANALYTICS()}/internal/tenants/${t.id}/analytics/brief/${branchId}`);
    let wording = plainBrief(`<brief_facts>${JSON.stringify(facts)}</brief_facts>`);
    let verified = false;
    let model = 'plain';
    try {
      const out = await this.llm.generate({ system: SYSTEM, turns: [{ role: 'user', text: `<brief_facts>${JSON.stringify(facts)}</brief_facts>` }], purpose: 'ops', responseSchema: SCHEMA, thinking: 'low', maxOutputTokens: 700, timeoutMs: 40_000 });
      const w = JSON.parse(out.text) as { headline?: string; points?: string[] };
      const points = (w.points ?? []).filter((p) => typeof p === 'string' && p.trim()).slice(0, 6).map((p) => p.trim().slice(0, 400));
      const allowed = allowedNumbers(facts);
      if (w.headline && points.length && !unknownNumbers([w.headline, ...points].join(' '), allowed).length) {
        wording = { headline: w.headline.trim().slice(0, 300), points };
        verified = true;
        model = out.model;
      } else this.log.warn(`${t.slug}: brief wording failed the number check; plain wording used`);
    } catch (e) {
      this.log.warn(`${t.slug}: brief wording: ${(e as Error).message}; plain wording used`);
    }
    return this.db.tx(async (c) => {
      const { rows: [r] } = await c.query(
        `INSERT INTO ops_briefs (id, branch_id, branch_name, day, headline, points, facts, verified, model) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (branch_id, day) DO UPDATE SET headline = excluded.headline, points = excluded.points, facts = excluded.facts, verified = excluded.verified, model = excluded.model, created_at = now()
         RETURNING *, (xmax = 0) AS inserted`,
        [randomUUID(), branchId, facts.branchName, facts.date, wording.headline, JSON.stringify(wording.points), JSON.stringify(facts), verified, model]);
      if (email && !r.emailed) {
        const data: OpsBrief = { briefId: r.id, branchId, branchName: r.branch_name, date: facts.date, headline: r.headline, points: r.points };
        await addToOutbox(c, Topics.assistant, branchId, envelope(EventTypes.opsBrief, data, { tenantId: t.id, subject: `${branchId}:${facts.date}` }));
        await c.query('UPDATE ops_briefs SET emailed = true WHERE id = $1', [r.id]);
      }
      return toBrief(r);
    });
  }

  async latest(branches: string[] | null) {
    const { rows } = await this.db.query(
      `SELECT DISTINCT ON (branch_id) * FROM ops_briefs WHERE ($1::uuid[] IS NULL OR branch_id = ANY($1)) ORDER BY branch_id, day DESC`, [branches]);
    return rows.map(toBrief).sort((a, b) => a.branchName.localeCompare(b.branchName));
  }
}

const toBrief = (r: any) => ({ id: r.id, branchId: r.branch_id, branchName: r.branch_name, day: dateOnly(r.day), headline: r.headline, points: r.points, verified: r.verified, model: r.model, emailed: r.emailed, createdAt: r.created_at });
