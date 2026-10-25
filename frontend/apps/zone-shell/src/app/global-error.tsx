'use client';
import '@mc/ui/theme.css';
import { ErrorView } from '@mc/ui/errors';

/** Last resort when the zone's layout itself fails (review F-1). */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <html lang="en"><body><ErrorView error={error} reset={reset} home="/" /></body></html>;
}
