import { Alert } from '@mc/ui';

/** Feedback after a server action: actions redirect back with ?ok= or ?error= (works without client JS). */
export function Flash({ ok, error }: { ok?: string; error?: string }) {
  if (error) return <Alert tone="error">{error}</Alert>;
  if (ok) return <Alert tone="success">{ok}</Alert>;
  return null;
}
