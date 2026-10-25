import { Card } from '@mc/ui';

/**
 * Shown to patients when the hospital's online booking is switched off or paused (module not in the plan, or the
 * subscription suspended: modules read-only). Instead of an error page (docs/ROLE-FLOWS-AND-GAPS.md F-2).
 */
export function BookingPaused({ what = 'Online booking' }: { what?: string }) {
  return (
    <Card>
      <h2 style={{ marginTop: 0 }}>{what} is paused at this hospital</h2>
      <p style={{ margin: 0 }}>Please call or visit the hospital to book. Your existing appointments, bills and reports are still under <a href="/care/appointments">My appointments</a>, <a href="/care/bills">My bills</a> and <a href="/care/lab-orders">My lab tests</a>.</p>
    </Card>
  );
}
