'use client';
/**
 * Razorpay Checkout (real gateway: test or live keys). Opens Razorpay's own payment sheet; on success posts the
 * three fields Razorpay returns to our server action, which verifies the signature with billing-service.
 */
import { useRef, useState } from 'react';

declare global { interface Window { Razorpay?: new (opts: Record<string, unknown>) => { open(): void; on(ev: string, cb: (r: any) => void): void } } }

function loadScript(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('could not load Razorpay Checkout'));
    document.body.appendChild(s);
  });
}

export function RazorpayButton({ keyId, orderId, amountPaise, hospital, description, invoiceId, label, action }: {
  keyId: string; orderId: string; amountPaise: number; hospital: string; description: string; invoiceId: string; label: string; action: (f: FormData) => Promise<void>;
}) {
  const form = useRef<HTMLFormElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const open = async () => {
    setError(null);
    setBusy(true);
    try {
      await loadScript();
      const rzp = new window.Razorpay!({
        key: keyId, order_id: orderId, amount: amountPaise, currency: 'INR', name: hospital, description,
        handler: (r: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) => {
          const f = form.current!;
          (f.elements.namedItem('razorpay_order_id') as HTMLInputElement).value = r.razorpay_order_id;
          (f.elements.namedItem('razorpay_payment_id') as HTMLInputElement).value = r.razorpay_payment_id;
          (f.elements.namedItem('razorpay_signature') as HTMLInputElement).value = r.razorpay_signature;
          f.requestSubmit();
        },
        modal: { ondismiss: () => setBusy(false) },
      });
      rzp.on('payment.failed', (r) => setError(r?.error?.description ?? 'Payment failed. You can try again.'));
      rzp.open();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <>
      <form ref={form} action={action} hidden>
        <input name="invoiceId" defaultValue={invoiceId} />
        <input name="razorpay_order_id" />
        <input name="razorpay_payment_id" />
        <input name="razorpay_signature" />
      </form>
      <button type="button" className="mc-btn mc-btn-primary" onClick={open} disabled={busy}>{busy ? 'Opening…' : label}</button>
      {error ? <p role="alert" className="mc-alert mc-alert-error" style={{ marginTop: 12 }}>{error}</p> : null}
    </>
  );
}
