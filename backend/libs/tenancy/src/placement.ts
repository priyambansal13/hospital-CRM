import type { TenantPlacement } from '@mc/contracts';
import { LRUCache } from 'lru-cache';

export class TenantNotFoundError extends Error {
  constructor(what: string) {
    super(`tenant not found: ${what}`);
  }
}

/** Where a tenant's database lives, and which host belongs to which tenant. */
export interface PlacementSource {
  get(tenantId: string): Promise<TenantPlacement>;
  resolveHost(host: string): Promise<TenantPlacement>;
  list(): Promise<TenantPlacement[]>;
  invalidate?(tenantId?: string): void;
}

export const normalizeHost = (host: string) => host.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');

/** Reads placements from tenant-service's internal API, cached briefly (catalog changes are rare). */
export class HttpPlacementSource implements PlacementSource {
  private byId = new LRUCache<string, TenantPlacement>({ max: 5000, ttl: 30_000 });
  private byHost = new LRUCache<string, TenantPlacement>({ max: 5000, ttl: 30_000 });
  private all?: { at: number; list: TenantPlacement[] };

  constructor(
    private readonly baseUrl = process.env.SVC_URL_TENANT ?? 'http://localhost:4401',
    private readonly token = process.env.INTERNAL_API_TOKEN ?? '',
  ) {}

  private async fetchJson<T>(path: string): Promise<T> {
    const res = await fetch(this.baseUrl + path, { headers: { 'x-internal-token': this.token } });
    if (res.status === 404) throw new TenantNotFoundError(path);
    if (!res.ok) throw new Error(`tenant-service ${path} → ${res.status}`);
    return (await res.json()) as T;
  }

  async get(tenantId: string) {
    const hit = this.byId.get(tenantId);
    if (hit) return hit;
    const p = await this.fetchJson<TenantPlacement>(`/internal/tenants/${encodeURIComponent(tenantId)}`);
    this.byId.set(tenantId, p);
    return p;
  }

  async resolveHost(host: string) {
    const h = normalizeHost(host);
    const hit = this.byHost.get(h);
    if (hit) return hit;
    const p = await this.fetchJson<TenantPlacement>(`/internal/resolve?host=${encodeURIComponent(h)}`);
    this.byHost.set(h, p);
    this.byId.set(p.id, p);
    return p;
  }

  async list() {
    if (this.all && Date.now() - this.all.at < 30_000) return this.all.list;
    const list = await this.fetchJson<TenantPlacement[]>('/internal/tenants');
    this.all = { at: Date.now(), list };
    return list;
  }

  invalidate(tenantId?: string) {
    if (tenantId) this.byId.delete(tenantId);
    else this.byId.clear();
    this.byHost.clear();
    this.all = undefined;
  }
}
