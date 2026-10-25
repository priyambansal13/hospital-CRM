'use client';
import { ErrorView } from '@mc/ui/errors';

/** Branded error page for this zone (review F-1). */
export default function ZoneError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorView error={error} reset={reset} home="/care" />;
}
