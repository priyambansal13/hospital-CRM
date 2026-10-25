import 'server-only';
import { api } from '@mc/bff';

interface TokenSet { accessToken: string; refreshToken: string; expiresIn: number }

/** Patient sign-in: phone OTP via iam-service (the hospital comes from the host). */
export const requestOtp = (phone: string) => api<{ sent: boolean; expiresIn: number }>('/api/iam/v1/auth/otp/request', { body: { phone } });
export const verifyOtp = (phone: string, code: string) => api<TokenSet & { newAccount: boolean }>('/api/iam/v1/auth/otp/verify', { body: { phone, code } });
export async function refreshPatient(refreshToken: string) {
  try {
    const t = await api<TokenSet>('/api/iam/v1/auth/refresh', { body: { refreshToken } });
    return { accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: Math.floor(Date.now() / 1000) + t.expiresIn };
  } catch {
    return undefined;
  }
}
export const logoutPatient = (refreshToken: string) => api('/api/iam/v1/auth/logout', { body: { refreshToken } }).catch(() => undefined);
