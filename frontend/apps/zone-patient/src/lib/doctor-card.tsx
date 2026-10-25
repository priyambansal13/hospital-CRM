import { feeRange, initials, languageName, nextAvailable, type PublicDoctor } from './directory';

export function DoctorCard({ d }: { d: PublicDoctor }) {
  const primary = d.specialties.find((s) => s.primary) ?? d.specialties[0];
  return (
    <article className="mc-card mc-doctor">
      <div className="mc-avatar" aria-hidden>{initials(d.name)}</div>
      <div>
        <h3><a href={`/care/doctors/${d.id}`}>{d.name}</a></h3>
        <p className="mc-meta">
          {[primary?.name, d.experienceYears != null ? `${d.experienceYears} yrs experience` : null, d.qualifications.join(', ') || null].filter(Boolean).join(' · ')}
        </p>
        <p className="mc-meta">
          {d.branches.map((b) => b.name).filter(Boolean).join(', ')}
          {d.languages.length ? ` · Speaks ${d.languages.map(languageName).join(', ')}` : ''}
        </p>
      </div>
      <div style={{ textAlign: 'right' }}>
        <p style={{ margin: 0, fontWeight: 600 }}>{feeRange(d)}</p>
        {d.nextAvailableAt ? <p className="mc-meta" style={{ margin: '4px 0 0' }}>Next available: <time dateTime={d.nextAvailableAt}>{nextAvailable(d.nextAvailableAt)}</time></p> : null}
        <a className="mc-btn mc-btn-ghost" href={`/care/doctors/${d.id}`} style={{ marginTop: 8 }}>View profile</a>
      </div>
    </article>
  );
}
