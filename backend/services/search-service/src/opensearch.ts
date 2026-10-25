import { DomainError } from '@mc/nest-common';

/** A minimal OpenSearch REST client (fetch). OPENSEARCH_URL, e.g. http://localhost:61920; INDEX_PREFIX keeps environments apart. */
export class OpenSearch {
  readonly base = (process.env.OPENSEARCH_URL ?? 'http://localhost:61920').replace(/\/$/, '');
  readonly prefix = process.env.SEARCH_INDEX_PREFIX ?? 'mc';

  index(tenantId: string, kind: 'doctors' | 'tests') {
    return `${this.prefix}-${tenantId}-${kind}`;
  }

  async req<T = any>(method: string, path: string, body?: unknown, opts: { ok404?: boolean; ndjson?: boolean; timeoutMs?: number } = {}): Promise<T | null> {
    const res = await fetch(this.base + path, {
      method,
      headers: body === undefined ? {} : { 'content-type': opts.ndjson ? 'application/x-ndjson' : 'application/json' },
      body: body === undefined ? undefined : opts.ndjson ? (body as string) : JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    }).catch((e) => { throw new DomainError(503, 'SEARCH_UNAVAILABLE', `search engine unreachable: ${(e as Error).message}`); });
    if (res.status === 404 && opts.ok404) return null;
    const text = await res.text();
    if (!res.ok) throw new DomainError(503, 'SEARCH_UNAVAILABLE', `search engine ${res.status}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : null) as T;
  }

  /** The index version stored in its _meta, or null if the index does not exist. */
  async version(index: string): Promise<string | null | undefined> {
    const r = await this.req<Record<string, any>>('GET', `/${index}/_mapping`, undefined, { ok404: true });
    if (!r) return null;
    return Object.values(r)[0]?.mappings?._meta?.version;
  }

  async create(index: string, def: { settings: unknown; mappings: Record<string, unknown> }, version: string) {
    await this.req('PUT', `/${index}`, { settings: def.settings, mappings: { ...def.mappings, _meta: { version } } });
  }

  async drop(index: string) {
    await this.req('DELETE', `/${index}`, undefined, { ok404: true });
  }

  /** Bulk index/update/delete; throws if any item failed. */
  async bulk(lines: unknown[]) {
    if (!lines.length) return;
    const r = await this.req<{ errors: boolean; items: any[] }>('POST', '/_bulk?refresh=wait_for', lines.map((l) => JSON.stringify(l)).join('\n') + '\n', { ndjson: true, timeoutMs: 30_000 });
    if (r?.errors) {
      const bad = r.items.map((i) => Object.values(i)[0] as any).find((i) => i.error && i.status !== 404);
      if (bad) throw new Error(`bulk: ${JSON.stringify(bad.error).slice(0, 300)}`);
    }
  }

  async search<T = any>(index: string, body: unknown, timeoutMs = 3000) {
    return this.req<{ hits: { total: { value: number }; hits: { _id: string; _score: number | null; _source: T; sort?: unknown[] }[] } }>('POST', `/${index}/_search`, body, { timeoutMs, ok404: true });
  }

  async ping() {
    return (await this.req<{ status: string }>('GET', '/_cluster/health', undefined, { timeoutMs: 2000 }))?.status;
  }

  /** All indexes of this environment, for clean-up of deleted hospitals. */
  async indexes(): Promise<string[]> {
    const r = await this.req<{ index: string }[]>('GET', `/_cat/indices/${this.prefix}-*?format=json&h=index`, undefined, { ok404: true });
    return (r ?? []).map((x) => x.index);
  }
}
