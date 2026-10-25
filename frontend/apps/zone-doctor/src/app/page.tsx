import { origin } from '@mc/bff';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/** Doctor zone home: today the schedule; the daily queue arrives in Phase 10. */
export default async function DoctorHome() {
  redirect(`${await origin()}/doctor/schedule`);
}
