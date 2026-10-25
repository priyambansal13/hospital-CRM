import { NotFoundView } from '@mc/ui/errors';

/** Branded not-found page for this zone (review F-1). */
export default function ZoneNotFound() {
  return <NotFoundView home="/doctor" />;
}
