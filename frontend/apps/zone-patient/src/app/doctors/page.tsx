import { ZoneFrame } from '@mc/features';
import { Button, Card, Chip, PageHeader, Select } from '@mc/ui';
import { DoctorCard } from '@/lib/doctor-card';
import { getBranches, getSpecialties, LANGUAGE_OPTIONS, searchDoctors } from '@/lib/directory';
import { BookingPaused } from '@/lib/booking-paused';
import { publicModules } from '@/lib/modules';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

const KEYS = ['q', 'specialty', 'branch', 'language', 'gender', 'mode', 'cursor'] as const;

export default async function DoctorSearch({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  if (!(await publicModules()).modules.includes('directory')) {
    return <ZoneFrame zone="patient" path="/care/doctors" zones={ZONES} requireAuth={false}><PageHeader title="Doctors" /><BookingPaused /></ZoneFrame>;
  }
  const params = new URLSearchParams();
  for (const k of KEYS) if (sp[k]) params.set(k, sp[k]!);
  const [specialties, branches, result] = await Promise.all([getSpecialties(), getBranches(), searchDoctors(params)]);
  const withSpecialty = (code?: string) => {
    const p = new URLSearchParams(params);
    p.delete('cursor');
    if (code) p.set('specialty', code); else p.delete('specialty');
    return `/care/doctors?${p}`;
  };
  const nextPage = new URLSearchParams(params);
  if (result.nextCursor) nextPage.set('cursor', result.nextCursor);
  const selected = specialties.find((s) => s.code === sp.specialty);
  return (
    <ZoneFrame zone="patient" path="/care/doctors" zones={ZONES} requireAuth={false}>
      <PageHeader title={selected ? `${selected.name} doctors` : 'Doctors'} subtitle={selected?.description ?? 'Choose a doctor to see their profile and fees.'} />
      <nav className="mc-chips" aria-label="Specialties">
        <Chip href={withSpecialty()} active={!sp.specialty}>All</Chip>
        {specialties.filter((s) => s.doctorCount > 0).map((s) => <Chip key={s.code} href={withSpecialty(s.code)} active={s.code === sp.specialty}>{s.name}</Chip>)}
      </nav>
      <Card>
        <form method="get" className="mc-form">
          {sp.specialty ? <input type="hidden" name="specialty" value={sp.specialty} /> : null}
          <label className="mc-field"><span>Name, specialty or symptom</span><input name="q" type="search" defaultValue={sp.q} placeholder="e.g. chest pain" /></label>
          <Select label="Branch" name="branch" defaultValue={sp.branch ?? ''} options={[{ value: '', label: 'Any branch' }, ...branches.map((b) => ({ value: b.id, label: b.name }))]} />
          <Select label="Language" name="language" defaultValue={sp.language ?? ''} options={[{ value: '', label: 'Any language' }, ...LANGUAGE_OPTIONS]} />
          <Select label="Doctor" name="gender" defaultValue={sp.gender ?? ''} options={[{ value: '', label: 'Any' }, { value: 'FEMALE', label: 'Female doctor' }, { value: 'MALE', label: 'Male doctor' }]} />
          <Button>Apply filters</Button>
        </form>
      </Card>
      <section className="mc-list" aria-label="Results" aria-live="polite" data-source={result.source}>
        {result.items.length ? result.items.map((d) => <DoctorCard key={d.id} d={d} />) : <p className="mc-muted">No doctors match these filters.</p>}
      </section>
      {result.nextCursor ? <p><a className="mc-btn mc-btn-ghost" href={`/care/doctors?${nextPage}`}>More doctors</a></p> : null}
    </ZoneFrame>
  );
}
