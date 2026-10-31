/**
 * @mc/bff: how zone server code (server components, server actions, route handlers) talks to the backend.
 * Every call goes through the Kong gateway with X-Tenant-Host = the hospital host the user is on; the backend
 * resolves the tenant from it and rejects tokens issued for another hospital.
 */
import 'server-only';
import { headers } from 'next/headers.js';
import { randomUUID } from 'node:crypto';

/** Host the browser used (shell rewrites to other zones keep it in x-forwarded-host). Includes the port. */
export async function requestHost(): Promise<string> {
  const h = await headers();
  return (h.get('x-forwarded-host') ?? h.get('host') ?? '').split(',')[0].trim();
}

/** X-Forwarded-For as the zone received it (load balancer → shell → zone), outside a request: none. */
async function clientChain(): Promise<string | null> {
  try {
    return (await headers()).get('x-forwarded-for');
  } catch {
    return null;
  }
}

/** Hospital host without port, e.g. "citycare.localhost". */
export async function tenantHost(): Promise<string> {
  return (await requestHost()).replace(/:\d+$/, '').toLowerCase();
}

/** Browser-facing origin, e.g. "http://citycare.localhost:3400" (absolute links across zones). */
export async function origin(): Promise<string> {
  const h = await headers();
  const proto = (h.get('x-forwarded-proto') ?? 'http').split(',')[0].trim();
  return `${proto}://${await requestHost()}`;
}

export interface ProblemBody {
  status: number;
  code: string;
  title?: string;
  detail?: string;
  errors?: { path: string; message: string }[];
  [k: string]: unknown;
}

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly problem: ProblemBody) {
    super(problem.detail ?? problem.title ?? `HTTP ${status}`);
  }
  get code() {
    return this.problem.code;
  }
}

export interface ApiOptions {
  method?: string;
  body?: unknown;
  token?: string;
  idempotencyKey?: string;
  /** override the tenant host (tests, platform console) */
  host?: string;
  /** give up after this long (callers with a fallback) */
  timeoutMs?: number;
}

const gateway = () => process.env.GATEWAY_URL ?? 'http://localhost:61000';

/** Call the gateway; returns parsed JSON (undefined for 204) or throws ApiError with the RFC 7807 body. */
export async function api<T = unknown>(path: string, opts: ApiOptions = {}): Promise<T> {
  const method = opts.method ?? (opts.body === undefined ? 'GET' : 'POST');
  const h: Record<string, string> = { 'x-tenant-host': opts.host ?? (await tenantHost()), 'x-request-id': randomUUID() };
  // the browser's address for rate limits and signup checks (review B-7): the gateway trusts this only from the zones
  const xff = await clientChain();
  if (xff) h['x-forwarded-for'] = xff;
  if (opts.body !== undefined) h['content-type'] = 'application/json';
  if (opts.token) h.authorization = `Bearer ${opts.token}`;
  if (opts.idempotencyKey) h['idempotency-key'] = opts.idempotencyKey;
  const res = await fetch(gateway() + path, { method, headers: h, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), cache: 'no-store', signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (!res.ok) throw new ApiError(res.status, (json as ProblemBody) ?? { status: res.status, code: `HTTP_${res.status}`, detail: text.slice(0, 200) });
  return json as T;
}

/**
 * Pass a server-sent-event stream from the backend through to the browser (zone route handlers). The upstream
 * request is aborted when the browser goes away.
 */
export async function proxyEventStream(path: string, token: string, signal: AbortSignal): Promise<Response> {
  const res = await fetch(gateway() + path, {
    headers: { 'x-tenant-host': await tenantHost(), 'x-request-id': randomUUID(), authorization: `Bearer ${token}`, accept: 'text/event-stream' },
    cache: 'no-store', signal,
  });
  if (!res.ok || !res.body) return new Response(await res.text().catch(() => ''), { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'text/plain' } });
  return new Response(res.body, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' } });
}

/** Pass a file (e.g. an invoice PDF) from the backend through to the browser (zone route handlers). */
export async function proxyFile(path: string, token: string): Promise<Response> {
  const res = await fetch(gateway() + path, { headers: { 'x-tenant-host': await tenantHost(), 'x-request-id': randomUUID(), authorization: `Bearer ${token}` }, cache: 'no-store' });
  const headers: Record<string, string> = { 'cache-control': 'private, no-store' };
  for (const h of ['content-type', 'content-disposition']) { const v = res.headers.get(h); if (v) headers[h] = v; }
  return new Response(res.body, { status: res.status, headers });
}

export interface Branding {
  tenantId: string;
  slug: string;
  name: string;
  branding: { primaryColor?: string; accentColor?: string; logoUrl?: string | null };
}

/** Public hospital branding for the current host (works before sign-in). */
export async function getBranding(): Promise<Branding> {
  return api<Branding>('/api/tenant/v1/public/branding');
}
