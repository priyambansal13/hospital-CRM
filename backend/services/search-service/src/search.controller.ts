import { Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { RequireModule } from '@mc/entitlements-sdk';
import { DomainError, Internal, notFound, parse, PLACEMENTS, TenantPublic } from '@mc/nest-common';
import { type PlacementSource, TenantContext } from '@mc/tenancy';
import { z } from 'zod';
import { IndexerService, type PublicDoctor } from './indexer.service.js';

/** Same parameters as provider's GET v1/public/doctors, so the patient zone can fall back to it unchanged. */
const DoctorSearch = z.object({
  q: z.string().trim().max(80).optional(),
  specialty: z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/).optional(),
  branch: z.uuid().optional(),
  language: z.string().regex(/^[a-z]{2,3}$/).optional(),
  gender: z.enum(['FEMALE', 'MALE', 'OTHER']).optional(),
  mode: z.enum(['IN_PERSON', 'VIDEO']).optional(),
  cursor: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
const TestSearch = z.object({ q: z.string().trim().max(80).optional() });

const score = (boost: number, query: unknown) => ({ constant_score: { filter: query, boost } });
const unavailable = () => new DomainError(503, 'SEARCH_UNAVAILABLE', 'search is not ready for this hospital yet');

/** Doctor query: specialty (with symptom synonyms) and name count most; ties go to whoever can see you soonest. */
export function doctorQuery(f: z.infer<typeof DoctorSearch>) {
  const filter: unknown[] = [];
  if (f.specialty) filter.push({ term: { specialtyCodes: f.specialty } });
  if (f.branch) filter.push({ term: { branchIds: f.branch } });
  if (f.language) filter.push({ term: { languages: f.language } });
  if (f.gender) filter.push({ term: { gender: f.gender } });
  if (f.mode) filter.push({ term: { modes: f.mode } });
  const q = f.q;
  const should = q ? [
    score(10, { match: { specialties: { query: q, operator: 'and' } } }),
    score(10, { match: { name: { query: q, operator: 'and' } } }),
    // typos in names ("kavitha"), without synonyms so a symptom never fuzzy-matches a name
    score(5, { match: { name: { query: q, operator: 'and', fuzziness: 'AUTO', analyzer: 'mc_text' } } }),
    score(4, { match: { keywords: { query: q, operator: 'and' } } }),
    // "cardiology kavita": words spread over name and specialty
    score(2, { multi_match: { query: q, type: 'cross_fields', fields: ['name', 'specialties', 'keywords'], operator: 'and' } }),
  ] : [];
  return {
    query: { bool: { filter, ...(q ? { should, minimum_should_match: 1 } : {}) } },
    sort: [{ _score: 'desc' }, { nextSort: 'asc' }, { 'name.raw': 'asc' }, { id: 'asc' }],
    track_scores: true,
  };
}

export function testQuery(q: string | undefined) {
  if (!q) return { query: { match_all: {} }, sort: [{ kind: 'asc' }, { price: 'asc' }, { 'name.raw': 'asc' }] };
  return {
    query: { bool: { minimum_should_match: 1, should: [
      score(20, { term: { code: q.toUpperCase().replace(/\s+/g, '_') } }),
      score(10, { match: { name: { query: q, operator: 'and' } } }),
      score(6, { match: { aliases: { query: q, operator: 'and' } } }),
      score(4, { match: { contains: { query: q, operator: 'and' } } }),
      score(3, { match: { name: { query: q, operator: 'and', fuzziness: 'AUTO', analyzer: 'mc_text' } } }),
      score(2, { match: { category: { query: q, operator: 'and' } } }),
    ] } },
    sort: [{ _score: 'desc' }, { kind: 'asc' }, { price: 'asc' }, { 'name.raw': 'asc' }],
    track_scores: true,
  };
}

const encode = (sort: unknown[]) => Buffer.from(JSON.stringify(sort)).toString('base64url');
function decode(cursor: string): unknown[] {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    if (Array.isArray(v) && v.length === 4) return v;
  } catch { /* fall through */ }
  throw new DomainError(400, 'BAD_CURSOR', 'invalid cursor');
}

/**
 * Patient-facing search (docs/IMPLEMENTATION-PLAN.md Phase 21). The hospital comes from the host and only that
 * hospital's indexes are ever queried. Errors are 503 so the patient zone falls back to the directory's own search.
 */
@Controller('v1/public/search')
export class SearchController {
  constructor(private readonly indexer: IndexerService) {}

  @Get('doctors')
  @TenantPublic()
  @RequireModule('directory')
  async doctors(@Query() query: unknown) {
    const f = parse(DoctorSearch, query);
    const t = TenantContext.require();
    const body = { ...doctorQuery(f), size: f.limit + 1, _source: ['profile', 'nextAvailableAt'], ...(f.cursor ? { search_after: decode(f.cursor) } : {}) };
    const r = await this.indexer.os.search<{ profile: PublicDoctor; nextAvailableAt: string | null }>(this.indexer.os.index(t.id, 'doctors'), body);
    if (!r) throw unavailable();
    const hits = r.hits.hits.slice(0, f.limit);
    return {
      items: hits.map((h) => ({ ...h._source.profile, nextAvailableAt: h._source.nextAvailableAt })),
      nextCursor: r.hits.hits.length > f.limit ? encode(hits.at(-1)!.sort!) : null,
    };
  }

  /** Same shape as diagnostics' GET v1/public/lab-catalog?q=, best matches first. */
  @Get('tests')
  @TenantPublic()
  @RequireModule('diagnostics')
  async tests(@Query() query: unknown) {
    const { q } = parse(TestSearch, query);
    const t = TenantContext.require();
    const r = await this.indexer.os.search<{ kind: string; item: unknown }>(this.indexer.os.index(t.id, 'tests'), { ...testQuery(q || undefined), size: 500, _source: ['kind', 'item'] });
    if (!r) throw unavailable();
    const hits = r.hits.hits.map((h) => h._source);
    return { packages: hits.filter((h) => h.kind === 'PACKAGE').map((h) => h.item), tests: hits.filter((h) => h.kind === 'TEST').map((h) => h.item) };
  }
}

/** Operations: rebuild one hospital's indexes now, and see how fresh they are. */
@Controller('internal/tenants/:tenantId/search')
export class InternalSearchController {
  constructor(private readonly indexer: IndexerService, @Inject(PLACEMENTS) private readonly placements: PlacementSource) {}

  private async tenant(tenantId: string) {
    if (!z.uuid().safeParse(tenantId).success) throw notFound('tenant');
    return this.placements.get(tenantId);
  }

  @Post('reindex')
  @Internal()
  @HttpCode(200)
  async reindex(@Param('tenantId') tenantId: string) {
    const t = await this.tenant(tenantId);
    return TenantContext.run(t, () => this.indexer.sync(t));
  }

  @Get()
  @Internal()
  async status(@Param('tenantId') tenantId: string) {
    const t = await this.tenant(tenantId);
    return TenantContext.run(t, async () => ({ engine: await this.indexer.os.ping().catch(() => 'unreachable'), indexes: await this.indexer.state() }));
  }
}
