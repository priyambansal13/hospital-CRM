/**
 * The caller's real IP (review B-7). Services are reachable only through the gateway, which works out the client
 * address from the trusted X-Forwarded-For chain and sets X-Real-IP (overwriting anything the client sent).
 * A raw X-Forwarded-For is never used: its first entry is whatever the client chose to put there.
 */
export function clientIp(req: { headers: Record<string, string | string[] | undefined>; ip?: string }): string | null {
  const real = req.headers['x-real-ip'];
  const v = (Array.isArray(real) ? real[0] : real) ?? req.ip ?? '';
  return v.trim() || null;
}
