import { getSession } from '@mc/auth';
import { api } from '@mc/bff';
import { can, ZoneFrame, zoneCapabilities } from '@mc/features';
import { Badge, Button, Card, Chip, PageHeader, Table, TextArea } from '@mc/ui';
import { Flash } from '@/lib/flash';
import { ZONES } from '@/lib/zones';
import { saveTemplate } from './actions';

export const dynamic = 'force-dynamic';

interface Row { id: string; channel: string; template: string; status: string; sendAt: string; sentAt: string | null; to: string | null; error: string | null; appointmentNo: string | null; patientName: string | null }
interface Template { id: string; key: string; channel: string; language: string; subject: string | null; body: string; active: boolean; providerTemplateId?: string | null; dltTemplateId?: string | null }

const LABEL: Record<string, string> = {
  appointment_confirmed: 'Booking confirmed', appointment_rescheduled: 'Rescheduled', appointment_cancelled: 'Cancelled',
  appointment_cancelled_doctor: 'Cancelled: doctor unavailable', reminder_24h: 'Reminder, 24 hours', reminder_2h: 'Reminder, 2 hours', waitlist_slot_available: 'Waitlist: time available',
};
const TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = { SENT: 'success', SCHEDULED: 'warning', FAILED: 'danger', SKIPPED: 'neutral', CANCELLED: 'neutral' };
const when = (iso: string) => new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(new Date(iso));

export default async function Messages({ searchParams }: { searchParams: Promise<{ tab?: string; status?: string; ok?: string; error?: string }> }) {
  const caps = await zoneCapabilities('admin', '/admin/messages');
  const { accessToken: token } = (await getSession())!;
  const sp = await searchParams;
  const canEdit = can(caps, 'notification:manage:tenant');
  const tab = sp.tab === 'templates' && canEdit ? 'templates' : 'log';
  const log = tab === 'log' ? await api<Row[]>(`/api/notification/v1/notifications?limit=100${sp.status ? `&status=${sp.status}` : ''}`, { token }) : [];
  const templates = tab === 'templates' ? await api<Template[]>('/api/notification/v1/notification-templates', { token }) : [];
  return (
    <ZoneFrame zone="admin" path="/admin/messages" zones={ZONES}>
      <PageHeader title="Messages" subtitle="SMS and email sent to patients: confirmations, reminders, cancellations." />
      <Flash ok={sp.ok} error={sp.error} />
      <nav className="mc-chips" aria-label="View">
        <Chip href="/admin/messages" active={tab === 'log' && !sp.status}>All messages</Chip>
        {['SCHEDULED', 'SENT', 'FAILED'].map((s) => <Chip key={s} href={`/admin/messages?status=${s}`} active={sp.status === s}>{s.charAt(0) + s.slice(1).toLowerCase()}</Chip>)}
        {canEdit ? <Chip href="/admin/messages?tab=templates" active={tab === 'templates'}>Templates</Chip> : null}
      </nav>
      {tab === 'log' ? (
        <Card>
          <Table
            rows={log}
            empty="No messages yet."
            columns={[
              { header: 'When', cell: (r) => when(r.sentAt ?? r.sendAt) },
              { header: 'Message', cell: (r) => LABEL[r.template] ?? r.template },
              { header: 'Channel', cell: (r) => (r.channel === 'SMS' ? 'SMS' : 'Email') },
              { header: 'Patient', cell: (r) => (r.patientName ? `${r.patientName}${r.appointmentNo ? ` · ${r.appointmentNo}` : ''}` : '—') },
              { header: 'To', cell: (r) => r.to ?? '—' },
              { header: 'Status', cell: (r) => <span title={r.error ?? undefined}><Badge tone={TONE[r.status] ?? 'neutral'}>{r.status.toLowerCase()}</Badge>{r.error && r.status !== 'SENT' ? <span className="mc-meta"> {r.error}</span> : null}</span> },
            ]}
          />
        </Card>
      ) : (
        templates.map((t) => (
          <Card key={t.id} title={`${LABEL[t.key] ?? t.key} · ${t.channel === 'SMS' ? 'SMS' : 'Email'} · ${t.language === 'hi' ? 'Hindi' : 'English'}`}>
            <form action={saveTemplate} className="mc-form" style={{ gridTemplateColumns: '1fr' }} id={`t-${t.id}`}>
              <input type="hidden" name="id" value={t.id} />
              {t.channel === 'EMAIL' ? (
                <label className="mc-field"><span>Subject</span><input name="subject" defaultValue={t.subject ?? ''} maxLength={200} /></label>
              ) : null}
              <TextArea label="Message" name="body" rows={t.channel === 'SMS' ? 3 : 8} defaultValue={t.body} maxLength={2000} />
              <p className="mc-meta" style={{ margin: 0 }}>Placeholders: {'{{hospital}} {{patientName}} {{doctorName}} {{when}} {{date}} {{time}} {{where}} {{appointmentNo}} {{fee}} {{link}}'}. SMS must not include medical details.</p>
              {t.channel === 'SMS' ? (
                // India's DLT rules (A-2): the SMS provider sends only templates registered on DLT, with the same wording
                <div className="mc-inline">
                  <label className="mc-field"><span>DLT template id</span><input name="dltTemplateId" defaultValue={t.dltTemplateId ?? ''} inputMode="numeric" pattern="\d{10,25}" /></label>
                  <label className="mc-field"><span>SMS provider template id</span><input name="providerTemplateId" defaultValue={t.providerTemplateId ?? ''} maxLength={60} /></label>
                </div>
              ) : null}
              <label className="mc-check"><input type="checkbox" name="active" defaultChecked={t.active} /> <span>Send this message</span></label>
              <Button variant="ghost">Save</Button>
            </form>
          </Card>
        ))
      )}
    </ZoneFrame>
  );
}
