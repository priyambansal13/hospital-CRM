import { getSession } from '@mc/auth';
import { api } from '@mc/bff';
import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { Badge, Button, Card, Field, PageHeader, Select, Table, TextArea } from '@mc/ui';
import { listSpecialties } from '@/lib/directory';
import { Flash } from '@/lib/flash';
import { ZONES } from '@/lib/zones';
import { addField, saveForm, toggleForm, updateField } from './actions';
import { type CustomField, type Form, questionsText, TYPES } from './lib';

export const dynamic = 'force-dynamic';

const ENTITY = { PATIENT: 'Patients', APPOINTMENT: 'Appointments' } as const;
const EXAMPLE = 'How long have you had these symptoms? | choice | Under a week, 1–4 weeks, Longer | required\nAny medicines you take now? | text\nAre you pregnant? | yes/no';

/** Admin: extra fields on patients and appointments, and the forms patients fill before a visit (Phase 27). */
export default async function CustomFields({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string; edit?: string; form?: string }> }) {
  await zoneCapabilities('admin', '/admin/custom-fields');
  const { accessToken: token } = (await getSession())!;
  const [fields, forms, specialties] = await Promise.all([
    api<CustomField[]>('/api/integration/v1/custom-fields', { token }), api<Form[]>('/api/integration/v1/forms', { token }), listSpecialties(token).catch(() => []),
  ]);
  const sp = await searchParams;
  const editing = fields.find((f) => f.id === sp.edit);
  const editForm = forms.find((f) => f.id === sp.form);

  return (
    <ZoneFrame zone="admin" path="/admin/custom-fields" zones={ZONES}>
      <PageHeader title="Custom fields and forms" subtitle="Extra details your hospital records on patients and appointments, and questions patients answer before a visit." />
      <Flash ok={sp.ok} error={sp.error} />
      {(['PATIENT', 'APPOINTMENT'] as const).map((entity) => (
        <Card key={entity} title={`${ENTITY[entity]}: custom fields`}>
          <Table
            rows={fields.filter((f) => f.entity === entity)}
            empty="No custom fields yet."
            columns={[
              { header: 'Field', cell: (f: CustomField) => <><strong>{f.label}</strong>{f.required ? ' *' : ''} <span className="mc-meta">{f.key}</span></> },
              { header: 'Type', cell: (f) => `${TYPES.find((t) => t.value === f.type)?.label}${f.type === 'SELECT' ? `: ${f.options.join(', ')}` : ''}` },
              { header: 'In use', cell: (f) => <Badge tone={f.active ? 'success' : 'neutral'}>{f.active ? 'Yes' : 'Off'}</Badge> },
              {
                header: 'Action',
                cell: (f) => (
                  <span style={{ display: 'flex', gap: 6 }}>
                    <a className="mc-btn mc-btn-ghost" href={`/admin/custom-fields?edit=${f.id}`}>Edit</a>
                    <form action={updateField}>
                      <input type="hidden" name="id" value={f.id} /><input type="hidden" name="version" value={f.version} /><input type="hidden" name="active" value={String(!f.active)} />
                      <Button variant="ghost">{f.active ? 'Switch off' : 'Switch on'}</Button>
                    </form>
                  </span>
                ),
              },
            ]}
          />
        </Card>
      ))}
      <Card title={editing ? `Edit "${editing.label}"` : 'Add a custom field'}>
        {editing ? (
          <form action={updateField} className="mc-form">
            <input type="hidden" name="id" value={editing.id} /><input type="hidden" name="version" value={editing.version} />
            <Field label="Label" name="label" required defaultValue={editing.label} />
            {editing.type === 'SELECT' ? <Field label="Choices (comma separated; you can add, not remove)" name="options" required defaultValue={editing.options.join(', ')} /> : null}
            <Field label="Help text" name="help" defaultValue={editing.help ?? ''} />
            <label className="mc-radio"><input type="checkbox" name="required" defaultChecked={editing.required} /> <span>Required</span></label>
            <Button>Save</Button>
            <a className="mc-btn mc-btn-ghost" href="/admin/custom-fields">Cancel</a>
          </form>
        ) : (
          <form action={addField} className="mc-form">
            <Select label="On" name="entity" options={[{ value: 'PATIENT', label: 'Patients' }, { value: 'APPOINTMENT', label: 'Appointments' }]} />
            <Field label="Label" name="label" required placeholder="Referral source" />
            <Select label="Type" name="type" options={TYPES} />
            <Field label="Choices (for a choice field, comma separated)" name="options" placeholder="Doctor, Friend, Online, Camp" />
            <Field label="Help text" name="help" />
            <label className="mc-radio"><input type="checkbox" name="required" /> <span>Required</span></label>
            <Button>Add field</Button>
          </form>
        )}
      </Card>

      <Card title="Pre-visit forms">
        <Table
          rows={forms}
          empty="No forms yet."
          columns={[
            { header: 'Form', cell: (f: Form) => <strong>{f.name}</strong> },
            { header: 'For', cell: (f) => (f.specialtyCode ? specialties.find((s) => s.code === f.specialtyCode)?.name ?? f.specialtyCode : 'Every visit') },
            { header: 'Questions', cell: (f) => f.fields.length },
            { header: 'In use', cell: (f) => <Badge tone={f.active ? 'success' : 'neutral'}>{f.active ? 'Yes' : 'Off'}</Badge> },
            {
              header: 'Action',
              cell: (f) => (
                <span style={{ display: 'flex', gap: 6 }}>
                  <a className="mc-btn mc-btn-ghost" href={`/admin/custom-fields?form=${f.id}#form-editor`}>Edit</a>
                  <form action={toggleForm}>
                    <input type="hidden" name="id" value={f.id} /><input type="hidden" name="version" value={f.version} /><input type="hidden" name="active" value={String(!f.active)} />
                    <Button variant="ghost">{f.active ? 'Switch off' : 'Switch on'}</Button>
                  </form>
                </span>
              ),
            },
          ]}
        />
      </Card>
      <div id="form-editor">
        <Card title={editForm ? `Edit "${editForm.name}"` : 'Add a form'}>
          <form action={saveForm} className="mc-form" style={{ gridTemplateColumns: '1fr' }}>
            {editForm ? <><input type="hidden" name="id" value={editForm.id} /><input type="hidden" name="version" value={editForm.version} /></> : null}
            <Field label="Name" name="name" required defaultValue={editForm?.name} placeholder="Before your visit" />
            {editForm ? null : <Select label="For" name="specialtyCode" options={[{ value: '', label: 'Every visit' }, ...specialties.filter((s) => s.active).map((s) => ({ value: s.code, label: s.name }))]} />}
            <Field label="Short introduction" name="intro" defaultValue={editForm?.intro ?? ''} placeholder="A few questions so the doctor is ready for you" />
            <TextArea label="Questions, one per line: question | type | choices | required" name="questions" rows={7} defaultValue={editForm ? questionsText(editForm.fields) : EXAMPLE} />
            <small className="mc-muted">Types: text, number, date, choice (list the choices, comma separated), yes/no. Patients see the form for the doctor&apos;s specialty, or the &quot;every visit&quot; form.</small>
            <span style={{ display: 'flex', gap: 8 }}><Button>{editForm ? 'Save form' : 'Add form'}</Button>{editForm ? <a className="mc-btn mc-btn-ghost" href="/admin/custom-fields">Cancel</a> : null}</span>
          </form>
        </Card>
      </div>
    </ZoneFrame>
  );
}
