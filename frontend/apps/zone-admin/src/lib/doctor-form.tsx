import { Badge, CheckboxGroup, Field, Select, TextArea } from '@mc/ui';
import type { Branch, Doctor, Specialty } from './directory';

/** Profile fields shared by "Add doctor" and "Edit doctor". Works without client JS. */
export function DoctorFields({ specialties, branches, doctor }: { specialties: Specialty[]; branches: Branch[]; doctor?: Doctor }) {
  const fee = (id: string) => doctor?.branches.find((b) => b.id === id);
  return (
    <>
      <Field label="Full name" name="name" required defaultValue={doctor?.name} placeholder="Dr. Asha Rao" />
      <Select label="Gender" name="gender" defaultValue={doctor?.gender ?? ''} options={[{ value: '', label: 'Not specified' }, { value: 'FEMALE', label: 'Female' }, { value: 'MALE', label: 'Male' }, { value: 'OTHER', label: 'Other' }]} />
      <Field label="Experience (years)" name="experienceYears" type="number" defaultValue={doctor?.experienceYears?.toString()} />
      <Field label="Qualifications" name="qualifications" defaultValue={doctor?.qualifications.join(', ')} placeholder="MBBS, MD (Medicine)" hint="Comma separated" />
      <Field label="Languages" name="languages" defaultValue={(doctor?.languages ?? ['en', 'hi']).join(', ')} hint="Codes, e.g. en, hi, ta" />
      {/* in person only until video rooms exist (Phase 28; review D-1) */}
      <input type="hidden" name="mode" value="IN_PERSON" />
      <CheckboxGroup legend="Specialties (first ticked is primary)" name="specialty" options={specialties.filter((s) => s.active).map((s) => ({ value: s.code, label: s.name }))} defaultValues={doctor?.specialties.map((s) => s.code)} />
      <fieldset className="mc-fieldset mc-field-wide">
        <legend>Branches and consultation fees (₹)</legend>
        <div className="mc-branch-fees">
          {branches.filter((b) => b.active).map((b) => (
            <div key={b.id} className="mc-branch-fee">
              <label className="mc-check"><input type="checkbox" name={`branch:${b.id}`} defaultChecked={!!fee(b.id)} /> <span>{b.name}</span></label>
              <input type="number" name={`fee:${b.id}`} min={0} step={50} placeholder="Fee" aria-label={`${b.name} fee`} defaultValue={fee(b.id)?.fee} />
              <input type="number" name={`followup:${b.id}`} min={0} step={50} placeholder="Follow-up fee" aria-label={`${b.name} follow-up fee`} defaultValue={fee(b.id)?.followupFee ?? undefined} />
            </div>
          ))}
          {!branches.some((b) => b.active) ? <p className="mc-muted">Add a branch first.</p> : null}
        </div>
      </fieldset>
      <TextArea label="About the doctor" name="bio" defaultValue={doctor?.bio ?? undefined} maxLength={2000} placeholder="Shown on the doctor's public profile" />
    </>
  );
}

export const statusBadge = (s: Doctor['status']) => (
  <Badge tone={s === 'ACTIVE' ? 'success' : s === 'DRAFT' ? 'warning' : 'neutral'}>{s === 'ACTIVE' ? 'Published' : s === 'DRAFT' ? 'Draft' : 'Unpublished'}</Badge>
);
