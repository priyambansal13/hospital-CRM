import { getSession } from '@mc/auth';
import { api } from '@mc/bff';
import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { Badge, Button, Card, Field, PageHeader, Select, Table, TextArea } from '@mc/ui';
import { Flash } from '@/lib/flash';
import { ZONES } from '@/lib/zones';
import { addRule, toggleRule } from './actions';

export const dynamic = 'force-dynamic';

interface Fact { key: string; label: string; type: 'number' | 'text' | 'choice'; options?: string[] }
interface Catalog { triggers: { key: string; label: string; facts: Fact[] }[]; audiences: { key: string; label: string }[]; actions: { key: string; label: string }[]; placeholders: string[] }
interface Rule { id: string; name: string; trigger: string; conditions: { fact: string; op: string; value: string }[]; actions: { type: string; [k: string]: string }[]; active: boolean; version: number }
interface Run { id: string; ruleName: string; subject: string; results: { action: string; ok: boolean; detail: string }[]; at: string }

const OPS = [{ value: 'eq', label: 'is' }, { value: 'neq', label: 'is not' }, { value: 'gte', label: 'at least' }, { value: 'lte', label: 'at most' }, { value: 'contains', label: 'contains' }, { value: 'set', label: 'is filled in' }, { value: 'not_set', label: 'is empty' }];
const when = (iso: string) => new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(new Date(iso));

/** Admin: workflow rules (Phase 27): when something happens and the conditions hold, do a few safe things. */
export default async function Workflows({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string; trigger?: string }> }) {
  await zoneCapabilities('admin', '/admin/workflows');
  const { accessToken: token } = (await getSession())!;
  const [cat, rules, runs, fields] = await Promise.all([
    api<Catalog>('/api/integration/v1/workflows/catalog', { token }), api<Rule[]>('/api/integration/v1/workflows/rules', { token }),
    api<Run[]>('/api/integration/v1/workflows/runs', { token }), api<{ key: string; label: string; entity: string; active: boolean }[]>('/api/integration/v1/custom-fields?entity=PATIENT', { token }),
  ]);
  const sp = await searchParams;
  const trig = cat.triggers.find((t) => t.key === sp.trigger);
  const factLabel = (t: string, f: string) => (f.startsWith('field.') ? fields.find((x) => `field.${x.key}` === f)?.label ?? f : cat.triggers.find((x) => x.key === t)?.facts.find((x) => x.key === f)?.label ?? f);
  const actionLabel = (a: Rule['actions'][number]) => `${cat.actions.find((x) => x.key === a.type)?.label ?? a.type}${a.type === 'TAG_PATIENT' ? ` "${a.tag}"` : a.type === 'NOTIFY_STAFF' ? ` (${cat.audiences.find((x) => x.key === a.audience)?.label})` : ''}`;

  return (
    <ZoneFrame zone="admin" path="/admin/workflows" zones={ZONES}>
      <PageHeader title="Workflow rules" subtitle="When something happens and your conditions hold, MediCare does it for you: e-mail staff, message the patient, tag them, or ask them to pay online." />
      <Flash ok={sp.ok} error={sp.error} />
      <Card title="Rules">
        <Table
          rows={rules}
          empty="No rules yet."
          columns={[
            { header: 'Rule', cell: (r: Rule) => <strong>{r.name}</strong> },
            { header: 'When', cell: (r) => <span>{cat.triggers.find((t) => t.key === r.trigger)?.label}{r.conditions.length ? <span className="mc-meta"> · if {r.conditions.map((c) => `${factLabel(r.trigger, c.fact)} ${OPS.find((o) => o.value === c.op)?.label} ${c.value}`.trim()).join(' and ')}</span> : null}</span> },
            { header: 'Then', cell: (r) => <span className="mc-meta">{r.actions.map(actionLabel).join('; ')}</span> },
            { header: 'On', cell: (r) => <Badge tone={r.active ? 'success' : 'neutral'}>{r.active ? 'On' : 'Off'}</Badge> },
            {
              header: 'Action',
              cell: (r) => (
                <form action={toggleRule}>
                  <input type="hidden" name="id" value={r.id} /><input type="hidden" name="version" value={r.version} /><input type="hidden" name="active" value={String(!r.active)} />
                  <Button variant="ghost">{r.active ? 'Switch off' : 'Switch on'}</Button>
                </form>
              ),
            },
          ]}
        />
      </Card>

      <Card title="Add a rule">
        <form method="get" className="mc-form">
          <Select label="When" name="trigger" defaultValue={trig?.key ?? ''} options={[{ value: '', label: 'Choose what happens…' }, ...cat.triggers.map((t) => ({ value: t.key, label: t.label }))]} />
          <Button variant="ghost">{trig ? 'Change' : 'Continue'}</Button>
        </form>
        {trig ? (
          <form action={addRule} className="mc-form" style={{ marginTop: 16 }}>
            <input type="hidden" name="trigger" value={trig.key} />
            <Field label="Rule name" name="name" required placeholder="Second no-show: pay online next time" />
            <h3 className="mc-field-wide" style={{ margin: '8px 0 0' }}>Only if (all of these)</h3>
            {[0, 1, 2].map((i) => (
              <div key={i} className="mc-field-wide mc-form" style={{ padding: 0, gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
                <Select label={`Condition ${i + 1}`} name={`fact${i}`} options={[{ value: '', label: '—' }, ...trig.facts.map((f) => ({ value: f.key, label: f.label })), ...(fields.some((f) => f.active) ? [{ value: '__field', label: 'Patient field…' }] : [])]} />
                {fields.some((f) => f.active) ? <Select label="Patient field" name={`field${i}`} options={[{ value: '', label: '—' }, ...fields.filter((f) => f.active).map((f) => ({ value: f.key, label: f.label }))]} /> : null}
                <Select label="Test" name={`op${i}`} options={OPS} />
                <Field label="Value" name={`value${i}`} placeholder="2" />
              </div>
            ))}
            <h3 className="mc-field-wide" style={{ margin: '8px 0 0' }}>Then</h3>
            <label className="mc-radio mc-field-wide"><input type="checkbox" name="a_staff" /> <span>E-mail staff</span></label>
            <Select label="Who" name="audience" options={cat.audiences.map((a) => ({ value: a.key, label: a.label }))} />
            <Field label="Subject" name="staffSubject" placeholder="{{patientName}} missed {{appointmentNo}}" />
            <TextArea label="Message" name="staffMessage" rows={2} placeholder="{{patientName}} ({{mrn}}) has missed {{noShows}} visits." />
            <label className="mc-radio mc-field-wide"><input type="checkbox" name="a_patient" /> <span>Message the patient (SMS and e-mail)</span></label>
            <Field label="Subject" name="patientSubject" placeholder="We missed you" />
            <TextArea label="Message (no medical details: it may go by SMS)" name="patientMessage" rows={2} />
            <label className="mc-radio mc-field-wide"><input type="checkbox" name="a_tag" /> <span>Tag the patient</span></label>
            <Field label="Tag" name="tag" placeholder="no-show risk" />
            <label className="mc-radio mc-field-wide"><input type="checkbox" name="a_prepay" /> <span>Ask the patient to pay online when booking</span></label>
            <Field label="Reason shown to the patient" name="reason" placeholder="two missed visits" />
            <label className="mc-radio mc-field-wide"><input type="checkbox" name="a_clear" /> <span>Stop asking the patient to pay online</span></label>
            <small className="mc-muted mc-field-wide">Placeholders: {cat.placeholders.map((p) => `{{${p}}}`).join(' ')}</small>
            <Button>Add rule</Button>
          </form>
        ) : null}
      </Card>

      <Card title="Recent runs">
        <Table
          rows={runs}
          empty="No rule has fired yet."
          columns={[
            { header: 'When', cell: (r: Run) => when(r.at) },
            { header: 'Rule', cell: (r) => r.ruleName },
            { header: 'About', cell: (r) => r.subject },
            { header: 'Done', cell: (r) => <span className="mc-meta">{r.results.map((x) => `${x.ok ? '✓' : '✗'} ${x.detail}`).join('; ')}</span> },
          ]}
        />
      </Card>
    </ZoneFrame>
  );
}
