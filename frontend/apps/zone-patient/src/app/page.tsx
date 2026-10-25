import { ZoneFrame } from '@mc/features';
import { Button, Card, PageHeader } from '@mc/ui';
import { BookingPaused } from '@/lib/booking-paused';
import { getSpecialties } from '@/lib/directory';
import { publicModules } from '@/lib/modules';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

/** Patient home: find a doctor by specialty or name. Public: patients can browse before signing in. */
export default async function CareHome() {
  const offered = await publicModules();
  if (!offered.modules.includes('directory')) {
    return <ZoneFrame zone="patient" path="/care" zones={ZONES} requireAuth={false}><PageHeader title="Find a doctor" /><BookingPaused /></ZoneFrame>;
  }
  const specialties = (await getSpecialties()).filter((s) => s.doctorCount > 0);
  return (
    <ZoneFrame zone="patient" path="/care" zones={ZONES} requireAuth={false}>
      <PageHeader title="Find a doctor" subtitle="Search by name or choose a specialty." />
      <Card>
        <form method="get" action="/care/doctors" className="mc-form">
          <label className="mc-field">
            <span>Doctor or specialty</span>
            <input name="q" type="search" placeholder="e.g. Sharma, skin, heart" />
          </label>
          <Button>Search</Button>
        </form>
      </Card>
      <section aria-labelledby="sp">
        <h2 id="sp">Specialties</h2>
        {specialties.length ? (
          <div className="mc-grid">
            {specialties.map((s) => (
              <a key={s.code} href={`/care/doctors?specialty=${s.code}`} className="mc-card mc-specialty">
                <h3>{s.name}</h3>
                <p className="mc-meta" style={{ margin: 0 }}>{s.description}</p>
                <p className="mc-meta" style={{ margin: '8px 0 0' }}>{s.doctorCount} doctor{s.doctorCount === 1 ? '' : 's'}</p>
              </a>
            ))}
          </div>
        ) : (
          <p className="mc-muted">Doctors will appear here soon.</p>
        )}
      </section>
    </ZoneFrame>
  );
}
