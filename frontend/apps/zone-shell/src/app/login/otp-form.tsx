'use client';
import { useActionState, useEffect } from 'react';
import { otpAction, type OtpState } from './actions';

export function OtpForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<OtpState, FormData>(otpAction, { step: 'phone', next });
  useEffect(() => {
    if (state.step === 'done') window.location.assign(state.next ?? '/');
  }, [state]);
  if (state.step === 'done') return <p role="status" className="mc-muted">Signed in. Opening your portal…</p>;
  return (
    <form action={action} className="mc-form" style={{ gridTemplateColumns: '1fr' }}>
      <input type="hidden" name="next" value={next} />
      {state.error ? <div role="alert" className="mc-alert mc-alert-error">{state.error}</div> : null}
      {state.step === 'phone' ? (
        <label className="mc-field">
          <span>Mobile number</span>
          <input name="phone" type="tel" inputMode="tel" autoComplete="tel" required placeholder="98765 43210" />
        </label>
      ) : (
        <>
          <p className="mc-muted" role="status">We sent a 6-digit code to {state.phone}.</p>
          <label className="mc-field">
            <span>Code</span>
            <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required autoFocus />
          </label>
        </>
      )}
      <button className="mc-btn mc-btn-primary" type="submit" disabled={pending}>
        {pending ? 'Please wait…' : state.step === 'phone' ? 'Send code' : 'Verify and sign in'}
      </button>
    </form>
  );
}
