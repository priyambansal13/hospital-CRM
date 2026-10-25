/**
 * Schedule editor shared by the doctor zone ("My schedule") and the admin zone ("Schedules"). Server component:
 * each zone passes its own server actions, so the API calls (and redirects) stay inside the zone.
 */
import { Badge, Button, Card, CheckboxGroup, Field, Select, Table } from '@mc/ui';
import type { ReactNode } from 'react';

export interface ScheduleData {
  doctor: { id: string; name: string; status: string };
  horizonDays: number;
  branches: { id: string; name: string; timezone: string; active: boolean }[];
  hours: { id: string; branchId: string; branchName: string; dayOfWeek: number; startTime: string; endTime: string; slotMinutes: number; mode: string; effectiveFrom: string; effectiveTo: string | null }[];
  leaves: { id: string; fromDate: string; toDate: string; reason: string | null }[];
  next14Days: { day: string; open: number; blocked: number; booked: number }[];
}

type Action = (form: FormData) => Promise<void>;
export interface ScheduleActions { addHours: Action; removeHours: Action; addLeave: Action; removeLeave: Action }

export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const fmtDate = (iso: string, opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' }) =>
  new Intl.DateTimeFormat('en-IN', { ...opts, timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));

function Hidden({ doctorId, back, children }: { doctorId: string; back: string; children?: ReactNode }) {
  return (
    <>
      <input type="hidden" name="doctorId" value={doctorId} />
      <input type="hidden" name="back" value={back} />
      {children}
    </>
  );
}

export function ScheduleEditor({ data, actions, back }: { data: ScheduleData; actions: ScheduleActions; back: string }) {
  const branches = data.branches.filter((b) => b.active);
  return (
    <>
      <Card title="Weekly hours">
        <Table
          rows={data.hours}
          empty="No working hours yet. Add them below and patients will be able to book these times."
          columns={[
            { header: 'Day', cell: (h) => DAY_NAMES[h.dayOfWeek - 1] },
            { header: 'Time', cell: (h) => `${h.startTime}–${h.endTime}` },
            { header: 'Branch', cell: (h) => h.branchName },
            { header: 'Slot length', cell: (h) => `${h.slotMinutes} min` },
            { header: 'Mode', cell: (h) => (h.mode === 'VIDEO' ? 'Video' : 'In person') },
            { header: 'From', cell: (h) => (h.effectiveTo ? `${fmtDate(h.effectiveFrom)} – ${fmtDate(h.effectiveTo)}` : fmtDate(h.effectiveFrom)) },
            {
              header: '',
              cell: (h) => (
                <form action={actions.removeHours}>
                  <Hidden doctorId={data.doctor.id} back={back}><input type="hidden" name="templateId" value={h.id} /></Hidden>
                  <Button variant="ghost">Remove</Button>
                </form>
              ),
            },
          ]}
        />
      </Card>

      <Card title="Add working hours">
        {branches.length ? (
          <form action={actions.addHours} className="mc-form">
            <Hidden doctorId={data.doctor.id} back={back} />
            <CheckboxGroup legend="Days" name="day" options={DAYS.map((d, i) => ({ value: String(i + 1), label: d }))} defaultValues={['1', '2', '3', '4', '5']} />
            <Select label="Branch" name="branchId" options={branches.map((b) => ({ value: b.id, label: b.name }))} />
            <Field label="Start" name="startTime" type="time" required defaultValue="10:00" />
            <Field label="End" name="endTime" type="time" required defaultValue="13:00" />
            <Select label="Slot length" name="slotMinutes" defaultValue="15" options={[5, 10, 15, 20, 30, 45, 60].map((m) => ({ value: String(m), label: `${m} minutes` }))} />
            {/* video hours return with video rooms (Phase 28; review D-1) */}
            <input type="hidden" name="mode" value="IN_PERSON" />
            <Field label="Starting from" name="effectiveFrom" type="date" hint="Leave empty to start today" />
            <Button>Add hours</Button>
          </form>
        ) : (
          <p className="mc-muted">This doctor has no active branch. Add one on the doctor profile first.</p>
        )}
      </Card>

      <Card title="Next 14 days">
        <Table
          rows={data.next14Days}
          empty="No slots in the next 14 days."
          columns={[
            { header: 'Date', cell: (d) => fmtDate(d.day) },
            { header: 'Open slots', cell: (d) => d.open },
            { header: 'Booked', cell: (d) => d.booked },
            { header: 'On leave', cell: (d) => (d.blocked ? <Badge tone="warning">{d.blocked} blocked</Badge> : '—') },
          ]}
        />
        <p className="mc-muted" style={{ marginBottom: 0 }}>Slots are kept open {data.horizonDays} days ahead and extended automatically.</p>
      </Card>

      <Card title="Leave">
        <Table
          rows={data.leaves}
          empty="No leave planned."
          columns={[
            { header: 'Dates', cell: (l) => (l.fromDate === l.toDate ? fmtDate(l.fromDate) : `${fmtDate(l.fromDate)} – ${fmtDate(l.toDate)}`) },
            { header: 'Reason', cell: (l) => l.reason ?? '—' },
            {
              header: '',
              cell: (l) => (
                <form action={actions.removeLeave}>
                  <Hidden doctorId={data.doctor.id} back={back}><input type="hidden" name="leaveId" value={l.id} /></Hidden>
                  <Button variant="ghost">Cancel leave</Button>
                </form>
              ),
            },
          ]}
        />
        <form action={actions.addLeave} className="mc-form" style={{ marginTop: 16 }}>
          <Hidden doctorId={data.doctor.id} back={back} />
          <Field label="From" name="fromDate" type="date" required />
          <Field label="To" name="toDate" type="date" required />
          <Field label="Reason (optional)" name="reason" placeholder="Conference" />
          <Button>Add leave</Button>
        </form>
      </Card>
    </>
  );
}

/** Form → API bodies (used by both zones' server actions). */
export const hoursBody = (f: FormData) => ({
  days: f.getAll('day').map(Number),
  branchId: String(f.get('branchId')),
  startTime: String(f.get('startTime')),
  endTime: String(f.get('endTime')),
  slotMinutes: Number(f.get('slotMinutes')),
  mode: String(f.get('mode') ?? 'IN_PERSON'),
  ...(f.get('effectiveFrom') ? { effectiveFrom: String(f.get('effectiveFrom')) } : {}),
});
export const leaveBody = (f: FormData) => ({ fromDate: String(f.get('fromDate')), toDate: String(f.get('toDate')), reason: String(f.get('reason') ?? '').trim() || null });
