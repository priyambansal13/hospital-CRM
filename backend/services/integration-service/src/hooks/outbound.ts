import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Outbound calls to a hospital's own systems (webhooks, the LIS). Every request is signed:
 * `x-medicare-signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>" with the endpoint's secret>`, so the
 * receiver can check it came from us and is fresh. Private and loopback addresses are refused in production
 * (SSRF: a webhook must not reach our own network); dev allows them (WEBHOOK_ALLOW_PRIVATE, default on outside prod).
 */
export const sign = (secret: string, body: string, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

const allowPrivate = () => (process.env.WEBHOOK_ALLOW_PRIVATE ?? (process.env.NODE_ENV === 'production' ? 'false' : 'true')) === 'true';
const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];
const isPrivate = (ip: string) => (isIP(ip) === 4 ? PRIVATE_V4.some((r) => r.test(ip)) : /^(::1|fc|fd|fe80|::ffff:(10|127|192\.168|172\.(1[6-9]|2\d|3[01]))\.)/i.test(ip) || ip === '::');

/** A URL we may call: http(s) only, https outside dev, and not a private address. Returns a reason when refused. */
export async function checkUrl(raw: string): Promise<string | null> {
  let u: URL;
  try { u = new URL(raw); } catch { return 'not a valid URL'; }
  if (!['https:', 'http:'].includes(u.protocol)) return 'use an https:// address';
  if (u.username || u.password) return 'put credentials in your receiver, not in the URL';
  if (allowPrivate()) return null;
  if (u.protocol !== 'https:') return 'use an https:// address';
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const ips = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!ips.length) return 'the address does not resolve';
  if (ips.some(isPrivate)) return 'private and internal addresses are not allowed';
  return null;
}

export async function post(url: string, secret: string, body: string, headers: Record<string, string>) {
  const refused = await checkUrl(url);
  if (refused) return { status: 0, error: refused };
  const res = await fetch(url, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10_000), body,
    headers: { 'content-type': 'application/json', 'user-agent': 'MediCare-Webhooks/1', 'x-medicare-signature': sign(secret, body), ...headers },
  }).catch((e: Error) => ({ status: 0, error: e.name === 'TimeoutError' ? 'timed out after 10 s' : e.message }) as const);
  if ('error' in res) return res;
  const text = await res.text().catch(() => '');
  return { status: res.status, error: res.ok ? null : `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}` };
}
