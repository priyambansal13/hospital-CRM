'use server';
import { requestOtp, setSession, verifyOtp } from '@mc/auth';
import { ApiError } from '@mc/bff';

export interface OtpState { step: 'phone' | 'code' | 'done'; phone?: string; error?: string; next?: string }

const safeNext = (n: unknown) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : '/');

export async function otpAction(prev: OtpState, form: FormData): Promise<OtpState> {
  const next = safeNext(form.get('next'));
  if (prev.step === 'phone' || form.get('restart')) {
    const phone = String(form.get('phone') ?? '');
    try {
      await requestOtp(phone);
      return { step: 'code', phone, next };
    } catch (e) {
      return { step: 'phone', error: e instanceof ApiError ? e.message : 'Could not send the code. Try again.', next };
    }
  }
  const code = String(form.get('code') ?? '');
  try {
    const t = await verifyOtp(prev.phone!, code);
    await setSession({ kind: 'patient', accessToken: t.accessToken, expiresAt: Math.floor(Date.now() / 1000) + t.expiresIn, name: prev.phone }, t.refreshToken);
  } catch (e) {
    return { ...prev, error: e instanceof ApiError ? e.message : 'Could not verify the code.' };
  }
  // The client does a full page load: `next` may belong to another zone (multi-zones can't soft-navigate across apps).
  return { step: 'done', next };
}
