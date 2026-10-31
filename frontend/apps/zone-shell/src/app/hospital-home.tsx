import { api } from '@mc/bff';
import { Icon, iconForSpecialty } from '@mc/ui';

/**
 * A hospital's public home page: what a patient needs first, from the hospital's live data (directory, search,
 * scheduling's next free times, the lab catalog). Every block is optional: a module the plan lacks, or a service that
 * is slow, just leaves its section out.
 */
interface Specialty { code: string; name: string; description: string | null; doctorCount: number }
interface Doctor { id: string; name: string; specialties: { code: string; name: string; primary: boolean }[]; branches: { id: string; name: string; fee: number }[]; languages: string[]; experienceYears: number | null; qualifications: string[]; nextAvailableAt?: string | null }
interface Pkg { id: string; code: string; name: string; description: string | null; price: number; tests: { name: string }[]; worth?: number }
interface Catalog { packages: Pkg[]; tests: { code: string }[] }

const soft = <T,>(p: Promise<T>, fallback: T) => p.catch(() => fallback);
const initials = (name: string) => name.replace(/^Dr\.?\s*/i, '').split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
const inr = (n: number) => `₹${new Intl.NumberFormat('en-IN').format(n)}`;

/** "Today, 11:45 am" / "Tomorrow, 9:00 am" / "Mon 3 Nov, 9:00 am" (India time). */
function when(iso: string) {
  const d = new Date(iso);
  const day = (x: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(x);
  const time = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(d);
  if (day(d) === day(new Date())) return `Today, ${time}`;
  if (day(d) === day(new Date(Date.now() + 86_400_000))) return `Tomorrow, ${time}`;
  return `${new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }).format(d)}, ${time}`;
}

export async function HospitalHome({ name }: { name: string }) {
  const [specialties, branches, found, catalog] = await Promise.all([
    soft(api<Specialty[]>('/api/provider/v1/public/specialties'), []),
    soft(api<{ id: string; name: string }[]>('/api/provider/v1/public/branches'), []),
    soft(api<{ items: Doctor[] }>('/api/search/v1/public/search/doctors?limit=24').catch(() => api<{ items: Doctor[] }>('/api/provider/v1/public/doctors?limit=24')), { items: [] }),
    soft(api<Catalog>('/api/diagnostics/v1/public/lab-catalog'), { packages: [], tests: [] }),
  ]);
  const active = specialties.filter((s) => s.doctorCount > 0).sort((a, b) => b.doctorCount - a.doctorCount);
  const doctors = found.items;
  const soonest = doctors.filter((d) => d.nextAvailableAt).sort((a, b) => Date.parse(a.nextAvailableAt!) - Date.parse(b.nextAvailableAt!));
  const featured = [...soonest, ...doctors.filter((d) => !d.nextAvailableAt)].slice(0, 6);
  const doctorCount = active.reduce((n, s) => n + s.doctorCount, 0) || doctors.length;
  const today = soonest.filter((d) => new Date(d.nextAvailableAt!).toDateString() === new Date().toDateString()).length;
  const packages = catalog.packages.map((p) => ({ ...p, worth: p.worth ?? p.tests.reduce((s, t) => s + ((t as { price?: number }).price ?? 0), 0) })).slice(0, 3);

  return (
    <>
      <div className="mc-emergency" role="note"><Icon name="phone" size={16} /> Emergency? Call <a href="tel:112">112</a> · Ambulance <a href="tel:108">108</a> · Our emergency department is open 24 hours</div>

      <section className="mc-hero" aria-label="Welcome">
        <div className="mc-hero-inner">
          <div>
            <span className="mc-eyebrow"><i aria-hidden />{today ? `${today} doctor${today === 1 ? '' : 's'} with free times today` : 'Book online in a minute'}</span>
            <h1>Care at <em>{name}</em>, booked in a minute.</h1>
            <p className="mc-lead">Find the right doctor by symptom or name, see their next free time, book and pay online. Lab tests, reports and a 24×7 assistant, all in one place.</p>
            <form className="mc-search" action="/care/doctors" role="search">
              <Icon name="search" size={20} />
              <input name="q" placeholder="Try “skin rash”, “child fever” or a doctor's name" aria-label="Symptom, specialty or doctor" />
              <button className="mc-btn mc-btn-primary" type="submit">Find a doctor</button>
            </form>
            <div className="mc-hero-tags">
              <span>Popular:</span>
              {['Fever', 'Skin rash', 'Back pain', 'Diabetes', 'Child vaccination'].map((t) => <a key={t} href={`/care/doctors?q=${encodeURIComponent(t.toLowerCase())}`}>{t}</a>)}
            </div>
          </div>
          {soonest.length ? (
            <div className="mc-hero-card" aria-label="Next available doctors">
              <h3>Next available</h3>
              {soonest.slice(0, 4).map((d) => (
                <a key={d.id} className="mc-next" href={`/care/doctors/${d.id}`}>
                  <span className="mc-avatar" aria-hidden>{initials(d.name)}</span>
                  <span><strong>{d.name}</strong><span>{(d.specialties.find((s) => s.primary) ?? d.specialties[0])?.name ?? 'Doctor'} · {d.branches[0]?.name}</span></span>
                  <em>{when(d.nextAvailableAt!)}</em>
                </a>
              ))}
              <a className="mc-btn mc-btn-ghost" href="/care/doctors">See all doctors</a>
            </div>
          ) : null}
        </div>
      </section>

      <div className="mc-stats" aria-label="At a glance">
        <div><strong>{doctorCount}</strong><span>Doctors</span></div>
        <div><strong>{active.length}</strong><span>Specialties</span></div>
        <div><strong>{branches.length}</strong><span>{branches.length === 1 ? 'Branch' : 'Branches'}</span></div>
        <div><strong>{catalog.tests.length + catalog.packages.length}</strong><span>Lab tests and packages</span></div>
      </div>

      <section className="mc-section" aria-label="What you can do">
        <div className="mc-tiles">
          {[
            { icon: 'calendar', title: 'Book a doctor', text: 'Pick a time that suits you', href: '/care/doctors' },
            { icon: 'flask', title: 'Lab tests', text: 'At the lab or sample from home', href: '/care/tests' },
            { icon: 'chat', title: 'Ask us, 24×7', text: 'Timings, fasting, bookings', href: '/care/assistant' },
            { icon: 'clipboard', title: 'My appointments', text: 'Move, cancel, pay', href: '/care/appointments' },
            { icon: 'file', title: 'My reports', text: 'Results as soon as they are ready', href: '/care/lab-orders' },
          ].map((t) => (
            <a key={t.href} className="mc-tile" href={t.href}>
              <span className="mc-tile-icon"><Icon name={t.icon} /></span>
              <strong>{t.title}</strong><span>{t.text}</span>
            </a>
          ))}
        </div>
      </section>

      {active.length ? (
        <section className="mc-section" aria-label="Specialties">
          <div className="mc-section-head">
            <div><span className="mc-kicker">Specialties</span><h2>Find the right department</h2></div>
            <a className="mc-btn mc-btn-ghost" href="/care">All specialties</a>
          </div>
          <div className="mc-tiles">
            {active.slice(0, 8).map((s) => (
              <a key={s.code} className="mc-tile" href={`/care/doctors?specialty=${s.code}`}>
                <span className="mc-tile-icon"><Icon name={iconForSpecialty(s.code)} /></span>
                <strong>{s.name}</strong>
                <span>{s.doctorCount} doctor{s.doctorCount === 1 ? '' : 's'}{s.description ? ` · ${s.description.split(/[,:]/)[0]}` : ''}</span>
              </a>
            ))}
          </div>
        </section>
      ) : null}

      {featured.length ? (
        <section className="mc-section" aria-label="Our doctors">
          <div className="mc-section-head">
            <div><span className="mc-kicker">Our doctors</span><h2>Book with a specialist</h2></div>
            <a className="mc-btn mc-btn-ghost" href="/care/doctors">Search all</a>
          </div>
          <div className="mc-docgrid">
            {featured.map((d) => {
              const sp = (d.specialties.find((s) => s.primary) ?? d.specialties[0])?.name ?? 'Doctor';
              const fee = Math.min(...d.branches.map((b) => b.fee));
              return (
                <a key={d.id} className="mc-doccard" href={`/care/doctors/${d.id}`}>
                  <div className="mc-doccard-top">
                    <span className="mc-avatar" aria-hidden>{initials(d.name)}</span>
                    <div><h3>{d.name}</h3><p>{sp}{d.experienceYears ? ` · ${d.experienceYears} yrs` : ''}</p></div>
                  </div>
                  <p>{d.qualifications.slice(0, 2).join(', ') || d.branches.map((b) => b.name).join(', ')}{d.languages.length ? ` · ${d.languages.map((l) => l.toUpperCase()).join(', ')}` : ''}</p>
                  <div className="mc-doccard-foot">
                    <span>{Number.isFinite(fee) ? `${inr(fee)} consultation` : ''}</span>
                    {d.nextAvailableAt ? <span className="mc-badge mc-badge-success">{when(d.nextAvailableAt)}</span> : <span className="mc-badge">See times</span>}
                  </div>
                </a>
              );
            })}
          </div>
        </section>
      ) : null}

      {packages.length ? (
        <section className="mc-section" aria-label="Health packages">
          <div className="mc-section-head">
            <div><span className="mc-kicker">Lab and health checks</span><h2>Health packages</h2></div>
            <a className="mc-btn mc-btn-ghost" href="/care/tests">All tests</a>
          </div>
          <div className="mc-features">
            {packages.map((p) => (
              <div key={p.id} className="mc-pkg">
                <h3>{p.name}</h3>
                <p className="mc-meta" style={{ margin: 0 }}>{p.description ?? p.tests.map((t) => t.name).join(', ')}</p>
                <div className="mc-price">{inr(p.price)}{p.worth && p.worth > p.price ? <s>{inr(p.worth)}</s> : null}</div>
                {p.worth && p.worth > p.price ? <span className="mc-save">You save {inr(p.worth - p.price)}</span> : null}
                <p className="mc-meta" style={{ margin: 0 }}>{p.tests.length} tests included</p>
                <a className="mc-btn mc-btn-primary" href={`/care/tests?q=${encodeURIComponent(p.name)}`}>Book this package</a>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {branches.length ? (
        <section className="mc-section" aria-label="Where to find us">
          <div className="mc-section-head"><div><span className="mc-kicker">Visit us</span><h2>Our branches</h2></div></div>
          <div className="mc-branches">
            {branches.slice(0, 8).map((b) => (
              <a key={b.id} className="mc-branch" href={`/care/doctors?branch=${b.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
                <span className="mc-tile-icon"><Icon name="building" /></span>
                <span><strong>{b.name}</strong><br /><span className="mc-meta">Doctors at this branch</span></span>
              </a>
            ))}
          </div>
        </section>
      ) : null}

      <div className="mc-band">
        <div className="mc-band-inner">
          <div>
            <h2>Questions at 2 am? Ask us.</h2>
            <p>Our assistant knows our timings, fasting rules and policies, finds doctors and books for you. A person is one tap away.</p>
          </div>
          <div className="mc-actions">
            <a className="mc-btn mc-btn-ghost mc-btn-lg" href="/care/assistant">Ask the assistant</a>
            <a className="mc-btn mc-btn-ghost mc-btn-lg" href="/login">Sign in</a>
          </div>
        </div>
      </div>
      <div style={{ height: 56 }} />
    </>
  );
}
