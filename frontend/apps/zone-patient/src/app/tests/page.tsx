import { ZoneFrame } from '@mc/features';
import { Button, Card, Field, PageHeader } from '@mc/ui';
import { catalog } from '@/lib/lab';
import { Flash } from '@/lib/flash';
import { publicModules } from '@/lib/modules';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

/** Lab tests and health packages: pick what you need, then a time at the lab. Browsable before sign-in. */
export default async function Tests({ searchParams }: { searchParams: Promise<{ q?: string; error?: string }> }) {
  const sp = await searchParams;
  const offered = await publicModules();
  if (!offered.modules.includes('diagnostics')) {
    // not in this hospital's plan (or no longer): no booking; earlier tests and reports stay under My lab tests
    return (
      <ZoneFrame zone="patient" path="/care/tests" zones={ZONES} requireAuth={false}>
        <PageHeader title="Lab tests" />
        <Card><p style={{ margin: 0 }}>Online lab test booking is not available at this hospital.</p>
          {offered.readOnly.includes('diagnostics') ? <p className="mc-meta" style={{ marginBottom: 0 }}>Your earlier tests and reports are still in <a href="/care/lab-orders">My lab tests</a>.</p> : null}</Card>
      </ZoneFrame>
    );
  }
  const cat = await catalog(sp.q);
  const byCategory = new Map<string, typeof cat.tests>();
  for (const t of cat.tests) byCategory.set(t.category, [...(byCategory.get(t.category) ?? []), t]);
  return (
    <ZoneFrame zone="patient" path="/care/tests" zones={ZONES} requireAuth={false}>
      <PageHeader title="Lab tests" subtitle="Health packages and single tests. Pick what you need, then choose a time at the lab." />
      <Flash error={sp.error} />
      <Card>
        <form method="get" className="mc-form">
          <Field label="Search" name="q" defaultValue={sp.q ?? ''} placeholder="sugar test, thyroid, vitamin D…" />
          <Button variant="ghost">Search</Button>
        </form>
      </Card>
      <form method="get" action="/care/tests/book">
        {cat.packages.length ? (
          <>
            <h2 className="mc-section-title">Health packages</h2>
            <div className="mc-grid">
              {cat.packages.map((p) => (
                <label key={p.id} className="mc-card" style={{ cursor: 'pointer' }} aria-label={`Package ${p.name}`}>
                  <strong><input type="checkbox" name="pkg" value={p.id} /> {p.name}</strong>
                  <p className="mc-stat" style={{ fontSize: '1.4rem' }}>₹{p.price} <span className="mc-meta" style={{ textDecoration: 'line-through' }}>₹{p.worth}</span></p>
                  <p className="mc-meta" style={{ margin: 0 }}>{p.description}</p>
                  <p className="mc-meta">{p.tests.length} tests: {p.tests.map((t) => t.name).join(', ')}</p>
                  {p.preparation ? <p className="mc-meta">Before: {p.preparation}</p> : null}
                </label>
              ))}
            </div>
          </>
        ) : null}
        <h2 className="mc-section-title">Single tests</h2>
        {[...byCategory.entries()].map(([category, tests]) => (
          <Card key={category} title={category}>
            <ul className="mc-queue">
              {tests.map((t) => (
                <li key={t.id} className="mc-queue-item">
                  <input type="checkbox" name="test" value={t.id} aria-label={t.name} />
                  <div><strong>{t.name}</strong><span className="mc-meta"> · {t.sampleType === 'NONE' ? 'at the lab' : t.sampleType.toLowerCase()} · report in ~{t.turnaroundHours} h{t.preparation ? ` · ${t.preparation}` : ''}</span></div>
                  <span>₹{t.price}</span>
                </li>
              ))}
            </ul>
          </Card>
        ))}
        {!cat.tests.length && !cat.packages.length ? <Card><p className="mc-empty">Nothing matches “{sp.q}”.</p></Card> : null}
        <p style={{ position: 'sticky', bottom: 12 }}><button type="submit" className="mc-btn mc-btn-primary">Continue to booking</button></p>
      </form>
    </ZoneFrame>
  );
}
