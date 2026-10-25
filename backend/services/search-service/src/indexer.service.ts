import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { EntitlementsClient } from '@mc/entitlements-sdk';
import { PLACEMENTS, retryInBackground } from '@mc/nest-common';
import { type PlacementSource, TenantContext, TenantDbRouter } from '@mc/tenancy';
import type { TenantPlacement } from '@mc/contracts';
import { createHash } from 'node:crypto';
import { OpenSearch } from './opensearch.js';
import { DOCTOR_INDEX, INDEX_VERSION, TEST_INDEX } from './synonyms.js';

type Kind = 'doctors' | 'tests';
const NO_SLOT = '9999-12-31T00:00:00Z';
const DEFS = { doctors: DOCTOR_INDEX, tests: TEST_INDEX };
const svc = (name: string, port: number) => process.env[`SVC_URL_${name}`] ?? `http://localhost:${port}`;
const internal = () => ({ 'x-internal-token': process.env.INTERNAL_API_TOKEN ?? '' });
const shardOf = (id: string, n: number) => createHash('md5').update(id).digest().readUInt32BE(0) % n;
/** Hospitals whose patients can search: active ones, and read-only ones (patients still browse). */
const searchable = (t: TenantPlacement) => t.status === 'ACTIVE' || t.status === 'READ_ONLY';

export interface PublicDoctor {
  id: string; name: string; gender: string | null; qualifications: string[]; experienceYears: number | null; languages: string[]; bio: string | null;
  photoUrl: string | null; consultModes: string[]; specialties: { code: string; name: string; primary: boolean }[]; branches: { id: string; name: string; fee: number }[];
}

/**
 * Keeps each hospital's two indexes (docs/IMPLEMENTATION-PLAN.md Phase 21) in step with the services that own the data:
 * doctors from provider's public directory (only published doctors, only what patients may see), "next available"
 * from scheduling's open slots, tests and packages from diagnostics' public catalog. Events update single doctors at
 * once; a periodic sync repairs anything an event missed (search is a copy, never the source of truth).
 */
@Injectable()
export class IndexerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('Indexer');
  private readonly timers: NodeJS.Timeout[] = [];
  private running = false;

  constructor(readonly os: OpenSearch, private readonly db: TenantDbRouter, @Inject(PLACEMENTS) private readonly placements: PlacementSource, private readonly entitlements: EntitlementsClient) {}

  onApplicationBootstrap() {
    if (process.env.MC_DISABLE_JOBS === 'true') return;
    retryInBackground('SearchIndexes', () => this.syncAll(true));
    const every = (ms: number, fn: () => Promise<unknown>) => this.timers.push(setInterval(() => void fn().catch((e) => this.log.warn((e as Error).message)), ms));
    every(Number(process.env.SEARCH_NEXT_SLOT_MS ?? 5 * 60_000), () => this.forEachTenant((t) => this.refreshNext(t)));
    every(Number(process.env.SEARCH_FULL_SYNC_MS ?? 30 * 60_000), () => this.syncAll(false));
  }
  onApplicationShutdown() {
    this.timers.forEach(clearInterval);
  }

  /** Every hospital of this replica: indexes up to date and fully synced; indexes of deleted hospitals dropped. */
  async syncAll(throwOnError: boolean) {
    if (this.running) return;
    this.running = true;
    try {
      await this.forEachTenant((t) => this.sync(t), throwOnError);
      await this.sweep();
    } finally {
      this.running = false;
    }
  }

  private async forEachTenant(fn: (t: TenantPlacement) => Promise<unknown>, throwOnError = false) {
    const n = Number(process.env.REPLICA_COUNT ?? 1), i = Number(process.env.REPLICA_INDEX ?? 0);
    for (const t of await this.placements.list()) {
      if (!searchable(t) || shardOf(t.id, n) !== i) continue;
      await TenantContext.run(t, () => fn(t)).catch((e) => {
        if (throwOnError && (e as { status?: number }).status === 503) throw e;
        this.log.warn(`${t.slug}: ${(e as Error).message}`);
      });
    }
  }

  /** One hospital: (re)create outdated indexes, then load everything. */
  async sync(t: TenantPlacement) {
    const rebuilt = await this.ensure(t);
    const doctors = await this.syncDoctors(t);
    const tests = await this.syncTests(t);
    return { rebuilt, doctors, tests, version: INDEX_VERSION };
  }

  /** Creates missing indexes and rebuilds ones made from older definitions (synonyms changed). */
  async ensure(t: TenantPlacement): Promise<Kind[]> {
    const rebuilt: Kind[] = [];
    for (const kind of ['doctors', 'tests'] as Kind[]) {
      const index = this.os.index(t.id, kind);
      const v = await this.os.version(index);
      if (v === INDEX_VERSION) continue;
      if (v !== null) await this.os.drop(index);
      await this.os.create(index, DEFS[kind], INDEX_VERSION);
      rebuilt.push(kind);
    }
    if (rebuilt.length) this.log.log(`${t.slug}: index ${rebuilt.join(', ')} created (version ${INDEX_VERSION})`);
    return rebuilt;
  }

  async drop(tenantId: string) {
    for (const kind of ['doctors', 'tests'] as Kind[]) await this.os.drop(this.os.index(tenantId, kind));
  }

  /** Indexes whose hospital is gone (deleted) are dropped. */
  private async sweep() {
    const known = new Map((await this.placements.list()).map((t) => [t.id, t]));
    const re = new RegExp(`^${this.os.prefix}-([0-9a-f-]{36})-(doctors|tests)$`);
    for (const index of await this.os.indexes()) {
      const id = re.exec(index)?.[1];
      if (!id) continue;
      const t = known.get(id);
      if (!t || t.status === 'DELETED') {
        await this.os.drop(index);
        this.log.log(`dropped ${index} (hospital ${t ? 'deleted' : 'unknown'})`);
      }
    }
  }

  // ---------- doctors ----------

  private async publicDoctors(t: TenantPlacement): Promise<PublicDoctor[]> {
    const all: PublicDoctor[] = [];
    let cursor: string | null = null;
    do {
      const q = new URLSearchParams({ limit: '50', ...(cursor ? { cursor } : {}) });
      const res = await fetch(`${svc('PROVIDER', 4404)}/v1/public/doctors?${q}`, { headers: { 'x-tenant-host': t.hosts[0] }, signal: AbortSignal.timeout(10_000) });
      if (res.status === 403) return []; // no directory module: nothing to find
      if (!res.ok) throw new Error(`provider ${res.status}`);
      const page = (await res.json()) as { items: PublicDoctor[]; nextCursor: string | null };
      all.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return all;
  }

  private async nextSlots(t: TenantPlacement, doctorId?: string): Promise<Record<string, string>> {
    const res = await fetch(`${svc('SCHEDULING', 4405)}/internal/tenants/${t.id}/next-slots${doctorId ? `?doctorId=${doctorId}` : ''}`, { headers: internal(), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`scheduling ${res.status}`);
    return ((await res.json()) as { next: Record<string, string> }).next;
  }

  private doctorDoc(d: PublicDoctor, next: string | null) {
    return {
      id: d.id,
      name: d.name,
      specialties: d.specialties.map((s) => s.name),
      keywords: [...d.qualifications, ...d.specialties.map((s) => s.code.replace(/_/g, ' '))].filter(Boolean),
      specialtyCodes: d.specialties.map((s) => s.code),
      branchIds: d.branches.map((b) => b.id),
      languages: d.languages,
      gender: d.gender,
      modes: d.consultModes,
      nextAvailableAt: next,
      nextSort: next ?? NO_SLOT,
      profile: d,
    };
  }

  /** All published doctors in; doctors no longer published out. */
  async syncDoctors(t: TenantPlacement) {
    const index = this.os.index(t.id, 'doctors');
    const [doctors, next] = await Promise.all([this.publicDoctors(t), this.nextSlots(t)]);
    const keep = new Set(doctors.map((d) => d.id));
    const stale = (await this.ids(index)).filter((id) => !keep.has(id));
    await this.os.bulk([
      ...doctors.flatMap((d) => [{ index: { _index: index, _id: d.id } }, this.doctorDoc(d, next[d.id] ?? null)]),
      ...stale.map((id) => ({ delete: { _index: index, _id: id } })),
    ]);
    await this.recordState('doctors', doctors.length, true);
    return doctors.length;
  }

  /** One doctor changed in the directory: re-read the public profile (gone or unpublished → removed). */
  async upsertDoctor(t: TenantPlacement, doctorId: string) {
    const index = this.os.index(t.id, 'doctors');
    const res = await fetch(`${svc('PROVIDER', 4404)}/v1/public/doctors/${doctorId}`, { headers: { 'x-tenant-host': t.hosts[0] }, signal: AbortSignal.timeout(10_000) });
    if (res.status === 404 || res.status === 403) return this.os.bulk([{ delete: { _index: index, _id: doctorId } }]);
    if (!res.ok) throw new Error(`provider ${res.status}`);
    const d = (await res.json()) as PublicDoctor;
    const next = await this.nextSlots(t, doctorId);
    await this.os.bulk([{ index: { _index: index, _id: d.id } }, this.doctorDoc(d, next[d.id] ?? null)]);
  }

  /** "Next available" of one doctor (slot events) or of everyone (periodic: time passes, slots fill up). */
  async refreshNext(t: TenantPlacement, doctorId?: string) {
    const index = this.os.index(t.id, 'doctors');
    const next = await this.nextSlots(t, doctorId);
    const ids = doctorId ? [doctorId] : await this.ids(index);
    await this.os.bulk(ids.flatMap((id) => [{ update: { _index: index, _id: id } }, { doc: { nextAvailableAt: next[id] ?? null, nextSort: next[id] ?? NO_SLOT } }]));
    if (!doctorId) await this.recordState('doctors', ids.length, false);
  }

  private async ids(index: string): Promise<string[]> {
    const r = await this.os.search<unknown>(index, { size: 10_000, _source: false, query: { match_all: {} } }, 10_000);
    return (r?.hits.hits ?? []).map((h) => h._id);
  }

  // ---------- tests ----------

  /** Tests and packages from the lab's public catalog, only while the hospital has an active diagnostics module. */
  async syncTests(t: TenantPlacement) {
    const index = this.os.index(t.id, 'tests');
    let docs: { id: string; doc: Record<string, unknown> }[] = [];
    if ((await this.entitlements.moduleState(t.id, 'diagnostics')) === 'ACTIVE') {
      const res = await fetch(`${svc('DIAGNOSTICS', 4412)}/v1/public/lab-catalog`, { headers: { 'x-tenant-host': t.hosts[0] }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`diagnostics ${res.status}`);
      const cat = (await res.json()) as { tests: any[]; packages: any[] };
      docs = [
        ...cat.tests.map((x) => ({ id: x.id, doc: { id: x.id, code: x.code, kind: 'TEST', name: x.name, aliases: x.aliases ?? [], category: x.category, contains: [], price: x.price, item: x } })),
        ...cat.packages.map((p) => ({ id: p.id, doc: { id: p.id, code: p.code, kind: 'PACKAGE', name: p.name, aliases: [p.description ?? ''], category: 'package checkup', contains: p.tests.map((x: any) => x.name), price: p.price, item: p } })),
      ];
    }
    const keep = new Set(docs.map((d) => d.id));
    const stale = (await this.ids(index)).filter((id) => !keep.has(id));
    await this.os.bulk([...docs.flatMap((d) => [{ index: { _index: index, _id: d.id } }, d.doc]), ...stale.map((id) => ({ delete: { _index: index, _id: id } }))]);
    await this.recordState('tests', docs.length, true);
    return docs.length;
  }

  // ---------- state ----------

  private async recordState(kind: Kind, documents: number, full: boolean) {
    await this.db.query(
      `INSERT INTO index_state (kind, version, documents) VALUES ($1,$2,$3)
       ON CONFLICT (kind) DO UPDATE SET version = $2, documents = $3, refreshed_at = now(), built_at = CASE WHEN $4 THEN now() ELSE index_state.built_at END`,
      [kind, INDEX_VERSION, documents, full]);
  }

  async state() {
    const { rows } = await this.db.query('SELECT kind, version, documents, built_at, refreshed_at FROM index_state ORDER BY kind');
    return rows.map((r) => ({ kind: r.kind, version: r.version, current: r.version === INDEX_VERSION, documents: r.documents, builtAt: r.built_at, refreshedAt: r.refreshed_at }));
  }
}
