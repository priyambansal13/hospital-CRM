import { Inject, Injectable, Logger } from '@nestjs/common';
import { DomainError, notFound } from '@mc/nest-common';
import { type Actor, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { randomUUID } from 'node:crypto';
import { LLM, type LlmClient, type ToolDecl, type ToolResult, type Turn } from '../llm/llm.js';
import { allowedNumbers, unknownNumbers } from './numbers.js';

const ANALYTICS = () => process.env.SVC_URL_ANALYTICS ?? 'http://localhost:4417';
const ROUNDS = 4;
const PER_HOUR = Number(process.env.OPS_QUESTIONS_PER_HOUR ?? 30);
export const OPS_PROMPT_VERSION = 'ops-1';

interface Catalog { metrics: { key: string; label: string; description: string; unit: string; dimensions: string[] }[]; dimensions: { key: string; label: string }[] }
export interface OpsTable { title: string; metric: string; unit: string; from: string; to: string; groupLabel: string | null; value: number | null; rows: { label: string; value: number | null }[] }

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const fmt = (v: number | null, unit: string) => (v == null ? 'no data' : unit === 'percent' ? `${v}%` : unit === 'inr' ? `₹${v}` : unit === 'hours' ? `${v} hours` : unit === 'days' ? `${v} days` : String(v));

/** The wording when the model's numbers do not check out (or it failed): the figures straight from the tables. */
export function plainAnswer(tables: OpsTable[]): string {
  if (!tables.length) return 'I could not find figures for that. Try asking about appointments, no-shows, utilisation, revenue or lab turnaround for a period.';
  return tables.map((t) => {
    if (!t.groupLabel) return `${t.title}, ${t.from} to ${t.to}: ${fmt(t.value, t.unit)}.`;
    const rows = t.rows.filter((r) => r.value != null);
    if (!rows.length) return `${t.title}, ${t.from} to ${t.to}: no data.`;
    const top = [...rows].sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    return `${t.title}, ${t.from} to ${t.to}: highest ${top[0].label} (${fmt(top[0].value, t.unit)})${top.length > 1 ? `, lowest ${top.at(-1)!.label} (${fmt(top.at(-1)!.value, t.unit)})` : ''}.`;
  }).join(' ');
}

/**
 * The Ops agent (docs/AI-AGENTS.md §6): an admin's question → metric queries on the semantic layer, **with the
 * admin's own token** (their branches apply; nobody, model included, writes SQL) → an answer in a few sentences plus
 * the tables. Every number in the answer must come from the tool results (numbers.ts); if not, the answer is
 * replaced by the plain figures. The warehouse holds no patient details, so neither can the answer.
 */
@Injectable()
export class OpsAgentService {
  private readonly log = new Logger('OpsAgent');
  private readonly catalogs = new Map<string, { at: number; c: Catalog }>();

  constructor(private readonly db: TenantDbRouter, @Inject(LLM) private readonly llm: LlmClient) {}

  private async analytics<T>(actor: Actor, path: string, body?: unknown): Promise<T> {
    const t = TenantContext.require();
    const res = await fetch(`${ANALYTICS()}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${actor.token}`, 'x-tenant-host': t.hosts[0], ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json().catch(() => ({}))) as T & { code?: string; detail?: string };
    if (!res.ok) throw Object.assign(new Error(data.detail ?? `analytics ${res.status}`), { status: res.status, code: data.code });
    return data;
  }

  private async catalog(actor: Actor): Promise<Catalog> {
    const t = TenantContext.require().id;
    const hit = this.catalogs.get(t);
    if (hit && Date.now() - hit.at < 300_000) return hit.c;
    const c = await this.analytics<Catalog>(actor, '/v1/analytics/catalog');
    this.catalogs.set(t, { at: Date.now(), c });
    return c;
  }

  private tools(c: Catalog): ToolDecl[] {
    return [{
      name: 'query_metric',
      description: 'Get one metric for a date range from the hospital\'s reports, optionally split by one dimension. Call it once per metric and split you need; for comparisons call it for each period.',
      parameters: {
        type: 'object',
        properties: {
          metric: { type: 'string', enum: c.metrics.map((m) => m.key) },
          from: { type: 'string', description: 'first day, YYYY-MM-DD' },
          to: { type: 'string', description: 'last day, YYYY-MM-DD (at most 400 days after from)' },
          group_by: { type: 'string', enum: c.dimensions.map((d) => d.key), description: 'optional split; each metric lists the splits it supports' },
          branch_id: { type: 'string', description: 'optional: one branch id' },
        },
        required: ['metric', 'from', 'to'],
      },
    }];
  }

  private system(c: Catalog) {
    const t = TenantContext.require();
    return [
      `You are the operations assistant for the administrators of ${t.name}. Today is <today>${today()}</today> (India time).`,
      'Answer questions about the hospital\'s operations only from the query_metric tool. Quote numbers exactly as the tool returns them (you may round to whole numbers). Do not calculate new figures such as differences, ratios or totals: if a comparison is needed, query each side and give both values.',
      'Always say which period the numbers cover. Answer in at most 120 words of plain sentences; do not draw tables, the screen shows the tool results as tables and charts.',
      'The reports hold counts and amounts only, no patient details: if asked about individual patients, say so. If a metric cannot be split the way asked, say which splits it has. If the question is not about the hospital\'s operations, say what you can help with.',
      'Metrics (key: meaning; splits):',
      ...c.metrics.map((m) => `- ${m.key}: ${m.description} (${m.unit}); splits: ${m.dimensions.join(', ')}`),
    ].join('\n');
  }

  async ask(actor: Actor, question: string) {
    const q = question.trim();
    if (q.length < 3 || q.length > 500) throw new DomainError(400, 'BAD_QUESTION', 'a question is 3 to 500 characters');
    const { rows: [n] } = await this.db.query(`SELECT count(*)::int n FROM ops_questions WHERE user_id = $1 AND created_at > now() - interval '1 hour'`, [actor.id]);
    if (n.n >= PER_HOUR) throw new DomainError(429, 'TOO_MANY_QUESTIONS', `at most ${PER_HOUR} questions an hour`);
    const catalog = await this.catalog(actor);
    const system = this.system(catalog);
    const tools = this.tools(catalog);
    const turns: Turn[] = [{ role: 'user', text: q }];
    const tables: OpsTable[] = [];
    const results: unknown[] = [];
    const calls: { metric: unknown; groupBy: unknown; from: unknown; to: unknown; ok: boolean }[] = [];
    let text = '';
    let model = this.llm.opsModel;
    const usage = { input: 0, output: 0 };
    try {
      for (let round = 0; round < ROUNDS; round++) {
        const out = await this.llm.generate({ system, turns, tools, purpose: 'ops', thinking: 'medium', maxOutputTokens: 1000, timeoutMs: 40_000 });
        model = out.model;
        usage.input += out.usage.input;
        usage.output += out.usage.output;
        if (!out.calls.length) { text = out.text.trim(); break; }
        turns.push({ role: 'model', calls: out.calls, raw: out.raw });
        const res: ToolResult[] = [];
        for (const call of out.calls.slice(0, 4)) {
          const a = call.args as { metric?: string; from?: string; to?: string; group_by?: string; branch_id?: string };
          try {
            if (call.name !== 'query_metric') throw new Error(`unknown tool ${call.name}`);
            const r = await this.analytics<OpsTable & { label: string; groupBy: string | null }>(actor, '/v1/analytics/query', {
              metric: a.metric, from: a.from, to: a.to, groupBy: a.group_by || undefined, filters: a.branch_id ? { branchId: a.branch_id } : {}, limit: 25,
            });
            const table: OpsTable = { title: r.groupLabel ? `${r.label} by ${r.groupLabel.toLowerCase()}` : r.label, metric: r.metric, unit: r.unit, from: r.from, to: r.to, groupLabel: r.groupLabel, value: r.value, rows: r.rows.map((x) => ({ label: x.label, value: x.value })) };
            tables.push(table);
            // ids stay out of the model's context: labels and values are enough
            const shown = { label: r.label, unit: r.unit, from: r.from, to: r.to, groupLabel: r.groupLabel, value: r.value, ...(r.groupBy ? { rows: table.rows } : {}) };
            results.push(shown);
            res.push({ id: call.id, name: call.name, response: shown });
            calls.push({ metric: a.metric, groupBy: a.group_by ?? null, from: a.from, to: a.to, ok: true });
          } catch (e) {
            res.push({ id: call.id, name: call.name, response: { error: (e as Error).message } });
            calls.push({ metric: a.metric, groupBy: a.group_by ?? null, from: a.from, to: a.to, ok: false });
          }
        }
        turns.push({ role: 'user', results: res });
      }
    } catch (e) {
      this.log.warn(`ops question failed: ${(e as Error).message}`);
    }
    const unknown = text ? unknownNumbers(text, allowedNumbers(results)) : [];
    const verified = !!text && unknown.length === 0;
    if (unknown.length) this.log.warn(`ops answer replaced: numbers not in the results: ${unknown.slice(0, 5).join(', ')}`);
    const answer = verified ? text : (tables.length ? `${unknown.length ? 'I could not check every figure in my answer, so here they are straight from the reports. ' : ''}${plainAnswer(tables)}` : (text && !unknown.length ? text : plainAnswer(tables)));
    const id = randomUUID();
    await this.db.query(`INSERT INTO ops_questions (id, user_id, question, answer, tables, calls, verified, model, tokens_in, tokens_out) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, actor.id, q, answer, JSON.stringify(tables), JSON.stringify(calls), verified, model, usage.input, usage.output]);
    return { id, question: q, answer, tables, verified, model, createdAt: new Date().toISOString() };
  }

  async history(actor: Actor) {
    const { rows } = await this.db.query(`SELECT * FROM ops_questions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`, [actor.id]);
    return rows.map((r) => ({ id: r.id, question: r.question, answer: r.answer, tables: r.tables, verified: r.verified, model: r.model, rating: r.rating, createdAt: r.created_at }));
  }

  async rate(actor: Actor, id: string, rating: 1 | -1) {
    const { rowCount } = await this.db.query('UPDATE ops_questions SET rating = $3 WHERE id = $1 AND user_id = $2', [id, actor.id, rating]);
    if (!rowCount) throw notFound('question');
  }
}
