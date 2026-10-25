import { Inject, Injectable, Logger } from '@nestjs/common';
import { EntitlementsClient } from '@mc/entitlements-sdk';
import { DomainError, notFound } from '@mc/nest-common';
import { type Queryable, TenantContext, TenantDbRouter } from '@mc/tenancy';
import type { TenantPlacement } from '@mc/contracts';
import { randomUUID } from 'node:crypto';
import { LLM, type LlmClient } from '../llm/llm.js';
import { checkOutput } from '../safety/output-policy.js';
import { DEFAULT_ARTICLES } from './defaults.js';

export type Source = 'FAQ' | 'POLICY' | 'EMERGENCY' | 'TEST_PREP';
export interface Hit { articleId: string; title: string; source: Source; text: string; score: number }

const CHUNK_CHARS = 700;
const vec = (v: number[]) => `[${v.map((x) => x.toFixed(6)).join(',')}]`;

/** Paragraphs packed into chunks of up to ~700 characters, each starting with the title (it carries the topic). */
export function chunk(title: string, body: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (const p of body.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean)) {
    if (cur && cur.length + p.length > CHUNK_CHARS) {
      out.push(cur);
      cur = '';
    }
    cur = cur ? `${cur}\n${p}` : p;
  }
  if (cur) out.push(cur);
  return out.map((c) => `${title}\n${c}`);
}

/**
 * The hospital's knowledge (docs/AI-AGENTS.md §8.1 kb_chunks): non-medical facts only, never patient data. Retrieval
 * is hybrid: vector similarity (embeddings) and Postgres full-text, merged by reciprocal rank, so exact words
 * ("HbA1c", "ICU") and paraphrases ("when can I see my mother") both find their article.
 */
@Injectable()
export class KbService {
  private readonly log = new Logger('Knowledge');

  constructor(private readonly db: TenantDbRouter, @Inject(LLM) private readonly llm: LlmClient, private readonly entitlements: EntitlementsClient) {}

  /** Embeds an article's chunks (replacing old ones). Runs inside the caller's transaction. */
  async index(c: Queryable, articleId: string, title: string, body: string) {
    const parts = chunk(title, body);
    const vectors = await this.llm.embed(parts, 'document');
    await c.query('DELETE FROM kb_chunks WHERE article_id = $1', [articleId]);
    for (let i = 0; i < parts.length; i++) {
      await c.query('INSERT INTO kb_chunks (id, article_id, seq, text, embedding, embed_model) VALUES ($1,$2,$3,$4,$5::public.vector,$6)', [randomUUID(), articleId, i, parts[i], vec(vectors[i]), this.llm.embedModel]);
    }
  }

  /** Day-one articles (insert-if-missing: the hospital's edits are never overwritten), and re-embedding after a model change. */
  async prepare(c: Queryable) {
    for (const a of DEFAULT_ARTICLES) {
      const { rows } = await c.query(`INSERT INTO kb_articles (id, source, source_ref, title, body, language) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (source, source_ref) WHERE source_ref IS NOT NULL DO NOTHING RETURNING id`, [randomUUID(), a.source, a.ref, a.title, a.body, a.language ?? 'en']);
      if (rows[0]) await this.index(c, rows[0].id, a.title, a.body);
    }
    const { rows: stale } = await c.query(`SELECT a.id, a.title, a.body FROM kb_articles a WHERE a.active AND NOT EXISTS (SELECT 1 FROM kb_chunks k WHERE k.article_id = a.id AND k.embed_model = $1)`, [this.llm.embedModel]);
    for (const a of stale) await this.index(c, a.id, a.title, a.body);
    if (stale.length) this.log.log(`${TenantContext.require().slug}: ${stale.length} articles embedded with ${this.llm.embedModel}`);
  }

  async search(query: string, k = 4): Promise<Hit[]> {
    const [q] = await this.llm.embed([query], 'query');
    const { rows } = await this.db.query(
      `WITH v AS (
         SELECT k.id, row_number() OVER (ORDER BY k.embedding OPERATOR(public.<=>) $1::public.vector) AS r, 1 - (k.embedding OPERATOR(public.<=>) $1::public.vector) AS sim
         FROM kb_chunks k JOIN kb_articles a ON a.id = k.article_id
         WHERE a.active AND k.embed_model = $3 ORDER BY k.embedding OPERATOR(public.<=>) $1::public.vector LIMIT 12),
       t AS (
         SELECT k.id, row_number() OVER (ORDER BY ts_rank(k.tsv, q) DESC) AS r
         FROM kb_chunks k JOIN kb_articles a ON a.id = k.article_id, websearch_to_tsquery('english', $2) q0,
              LATERAL (SELECT to_tsquery('english', replace(q0::text, '&', '|')) AS q) x
         WHERE a.active AND q0::text <> '' AND k.tsv @@ q ORDER BY ts_rank(k.tsv, q) DESC LIMIT 12)
       SELECT k.article_id, a.title, a.source, k.text,
              coalesce(1.0 / (60 + v.r), 0) + coalesce(1.0 / (60 + t.r), 0) AS score, v.sim, t.r IS NOT NULL AS lexical
       FROM kb_chunks k JOIN kb_articles a ON a.id = k.article_id
       LEFT JOIN v ON v.id = k.id LEFT JOIN t ON t.id = k.id
       WHERE v.id IS NOT NULL OR t.id IS NOT NULL
       ORDER BY score DESC LIMIT $4`,
      [vec(q), query, this.llm.embedModel, k * 2]);
    // one chunk per article, best first
    const seen = new Set<string>();
    return rows.filter((r) => !seen.has(r.article_id) && seen.add(r.article_id)).slice(0, k)
      .map((r) => ({ articleId: r.article_id, title: r.title, source: r.source, text: r.text.slice(r.text.indexOf('\n') + 1), score: Number(r.score) }));
  }

  /** The hospital's own emergency information, for the fixed emergency reply. */
  async emergencyInfo(): Promise<string | null> {
    const { rows } = await this.db.query(`SELECT body FROM kb_articles WHERE source = 'EMERGENCY' AND active ORDER BY updated_at DESC LIMIT 1`);
    return rows[0]?.body ?? null;
  }

  // ---------- editing (Admin → Assistant knowledge) ----------

  async list() {
    const { rows } = await this.db.query(`SELECT a.*, (SELECT count(*)::int FROM kb_chunks k WHERE k.article_id = a.id) AS chunks FROM kb_articles a ORDER BY a.source, a.title`);
    return rows.map(toArticle);
  }

  /** The assistant would refuse to repeat advice anyway; refusing it here tells the editor why. */
  private assertSafe(title: string, body: string) {
    const p = checkOutput(`${title}\n${body}`);
    if (!p.ok) throw new DomainError(422, 'KNOWLEDGE_UNSAFE', `the assistant may not give medical advice (${p.rules.join(', ')}): remove medicine names with doses or instructions, and diagnoses`, { rules: p.rules });
  }

  async create(v: { source: Source; title: string; body: string; language: string }, userId: string) {
    if (v.source === 'TEST_PREP') throw new DomainError(422, 'READ_ONLY_SOURCE', 'test preparation comes from the lab catalog');
    this.assertSafe(v.title, v.body);
    const id = randomUUID();
    await this.db.tx(async (c) => {
      await c.query('INSERT INTO kb_articles (id, source, title, body, language, updated_by) VALUES ($1,$2,$3,$4,$5,$6)', [id, v.source, v.title, v.body, v.language, userId]);
      await this.index(c, id, v.title, v.body);
    });
    return this.get(id);
  }

  async update(id: string, v: { title?: string; body?: string; active?: boolean; version: number }, userId: string) {
    await this.db.tx(async (c) => {
      const { rows: [a] } = await c.query('SELECT * FROM kb_articles WHERE id = $1 FOR UPDATE', [id]);
      if (!a) throw notFound('article');
      if (a.source === 'TEST_PREP') throw new DomainError(422, 'READ_ONLY_SOURCE', 'test preparation comes from the lab catalog: change it there');
      if (a.version !== v.version) throw new DomainError(409, 'STALE', 'someone else changed this article; reload it');
      const title = v.title ?? a.title, body = v.body ?? a.body;
      this.assertSafe(title, body);
      await c.query('UPDATE kb_articles SET title = $2, body = $3, active = coalesce($4, active), version = version + 1, updated_by = $5, updated_at = now() WHERE id = $1', [id, title, body, v.active ?? null, userId]);
      if (title !== a.title || body !== a.body) await this.index(c, id, title, body);
    });
    return this.get(id);
  }

  async remove(id: string) {
    const { rows: [a] } = await this.db.query('SELECT source FROM kb_articles WHERE id = $1', [id]);
    if (!a) throw notFound('article');
    if (a.source === 'TEST_PREP' || a.source === 'EMERGENCY') throw new DomainError(422, 'CANNOT_DELETE', a.source === 'EMERGENCY' ? 'edit the emergency information instead; the assistant always needs it' : 'test preparation comes from the lab catalog');
    await this.db.query('DELETE FROM kb_articles WHERE id = $1', [id]);
  }

  async get(id: string) {
    const { rows } = await this.db.query(`SELECT a.*, (SELECT count(*)::int FROM kb_chunks k WHERE k.article_id = a.id) AS chunks FROM kb_articles a WHERE id = $1`, [id]);
    if (!rows[0]) throw notFound('article');
    return toArticle(rows[0]);
  }

  // ---------- test preparation from the lab catalog ----------

  /** One TEST_PREP article per test/package with preparation, while the hospital has an active lab; gone tests removed. */
  async syncTestPrep(t: TenantPlacement) {
    let items: { ref: string; title: string; body: string }[] = [];
    if ((await this.entitlements.moduleState(t.id, 'diagnostics')) === 'ACTIVE') {
      const res = await fetch(`${process.env.SVC_URL_DIAGNOSTICS ?? 'http://localhost:4412'}/v1/public/lab-catalog`, { headers: { 'x-tenant-host': t.hosts[0] }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`diagnostics ${res.status}`);
      const cat = (await res.json()) as { tests: any[]; packages: any[] };
      items = [
        ...cat.tests.filter((x) => x.preparation || x.fastingHours).map((x) => ({
          ref: `test:${x.code}`, title: `${x.name}: how to prepare`,
          body: [`${x.name} (${x.code}).`, x.preparation ? `Preparation: ${x.preparation}.` : '', x.fastingHours ? `Fasting: ${x.fastingHours} hours, plain water is fine.` : 'No fasting needed.', x.sampleType ? `Sample: ${String(x.sampleType).toLowerCase()}.` : '', x.turnaroundHours ? `Report in about ${x.turnaroundHours} hours.` : '', `Price ₹${x.price}.`].filter(Boolean).join(' '),
        })),
        ...cat.packages.map((p) => ({
          ref: `package:${p.code}`, title: `${p.name} package: how to prepare`,
          body: [`${p.name}: ${p.tests.map((x: any) => x.name).join(', ')}.`, p.preparation ? `Preparation: ${p.preparation}.` : 'No special preparation.', `Price ₹${p.price}.`].join(' '),
        })),
      ];
    }
    await this.db.tx(async (c) => {
      const keep = items.map((i) => i.ref);
      await c.query(`DELETE FROM kb_articles WHERE source = 'TEST_PREP' AND source_ref LIKE ANY (ARRAY['test:%','package:%']) AND NOT (source_ref = ANY($1))`, [keep]);
      for (const i of items) {
        const { rows: [old] } = await c.query(`SELECT id, title, body FROM kb_articles WHERE source = 'TEST_PREP' AND source_ref = $1`, [i.ref]);
        if (old && old.title === i.title && old.body === i.body) continue;
        const id = old?.id ?? randomUUID();
        if (old) await c.query('UPDATE kb_articles SET title = $2, body = $3, version = version + 1, updated_at = now() WHERE id = $1', [id, i.title, i.body]);
        else await c.query(`INSERT INTO kb_articles (id, source, source_ref, title, body) VALUES ($1,'TEST_PREP',$2,$3,$4)`, [id, i.ref, i.title, i.body]);
        await this.index(c, id, i.title, i.body);
      }
    });
    return items.length;
  }
}

const toArticle = (a: any) => ({
  id: a.id, source: a.source as Source, ref: a.source_ref, title: a.title, body: a.body, language: a.language, active: a.active,
  version: a.version, chunks: a.chunks, updatedAt: a.updated_at, editable: a.source !== 'TEST_PREP',
});
