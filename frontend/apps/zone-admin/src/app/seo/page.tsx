import { getSession } from '@mc/auth';
import { api } from '@mc/bff';
import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { site } from '@mc/features/seo';
import { Badge, Button, Card, PageHeader, Table } from '@mc/ui';
import type { Doctor } from '@/lib/directory';
import { Flash } from '@/lib/flash';
import { ZONES } from '@/lib/zones';
import { saveArea, saveDescription } from './actions';

export const dynamic = 'force-dynamic';

interface Branch { id: string; name: string; city: string; area: string | null; active: boolean; version: number }
interface PublicBranch { id: string; slug: string }
interface Catalog { packages: { code: string; name: string }[] }
interface MetricResult { rows: { key: string | null; label: string; value: number | null }[] }

/** Sources a hospital typically links from; anything else can be typed. */
const SOURCES = ['google-business', 'whatsapp', 'facebook', 'instagram', 'sms', 'poster', 'newspaper', 'partner'];
const tag = (s: string | undefined) => (s ?? '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
const slugOf = (code: string) => code.toLowerCase().replace(/_/g, '-');

/** What a doctor's public profile is missing (what patients and search engines look for). */
function profileGaps(d: Doctor): string[] {
  const gaps: string[] = [];
  if (d.status !== 'ACTIVE') gaps.push('not published');
  if (!d.bio || d.bio.length < 120) gaps.push(d.bio ? 'short "about" (under 120 characters)' : 'no "about"');
  if (!d.photoUrl) gaps.push('no photo');
  if (!d.qualifications.length) gaps.push('no qualifications');
  if (d.experienceYears == null) gaps.push('no years of experience');
  if (d.languages.length < 2) gaps.push('one language only');
  return gaps;
}

type Q = { ok?: string; error?: string; page?: string; source?: string; campaign?: string };

/**
 * The hospital's own search and advertising (docs/SEO-AND-ADS.md §2.2 and §4): what search engines show, what's
 * missing from doctors' profiles, campaign links and the bookings they bring, the Google Business Profile checklist,
 * and India's rules on medical advertising. No ad pixels: links carry the campaign, bookings record it.
 */
export default async function Seo({ searchParams }: { searchParams: Promise<Q> }) {
  const caps = await zoneCapabilities('admin', '/admin/seo');
  const sp = await searchParams;
  const { accessToken: token } = (await getSession())!;
  const s = await site();
  const soft = <T,>(p: Promise<T>, fallback: T) => p.catch(() => fallback);
  const directory = caps.modules.includes('directory');
  const diagnostics = caps.modules.includes('diagnostics');
  const analytics = caps.modules.includes('analytics');
  const to = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const from = new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10);
  const [branches, pub, doctors, catalog, byCampaign] = await Promise.all([
    soft(api<Branch[]>('/api/tenant/v1/branches', { token }), []),
    soft(api<PublicBranch[]>('/api/tenant/v1/public/branches'), []),
    directory ? soft(api<{ items: Doctor[] }>('/api/provider/v1/doctors?limit=100', { token }), { items: [] }) : { items: [] as Doctor[] },
    diagnostics ? soft(api<Catalog>('/api/diagnostics/v1/public/lab-catalog'), { packages: [] }) : { packages: [] },
    analytics ? soft(api<MetricResult>('/api/analytics/v1/analytics/query', { token, method: 'POST', body: { metric: 'appointments', from, to, groupBy: 'campaign', limit: 20 } }), null) : null,
  ]);
  const slug = new Map(pub.map((b) => [b.id, b.slug]));
  const published = doctors.items.filter((d) => d.status === 'ACTIVE');

  // campaign link builder (works without JS: the form submits back here)
  const pages: { value: string; label: string }[] = [
    { value: '/', label: 'Home page' },
    ...(directory ? [{ value: '/care/doctors', label: 'Find a doctor' }] : []),
    ...pub.map((b) => ({ value: `/care/branches/${b.slug}`, label: `Branch: ${branches.find((x) => x.id === b.id)?.name ?? b.slug}` })),
    ...published.filter((d) => d.slug).map((d) => ({ value: `/care/doctors/${d.slug}`, label: `Doctor: ${d.name}` })),
    ...(diagnostics ? [{ value: '/care/tests', label: 'Lab tests' }] : []),
    ...catalog.packages.map((p) => ({ value: `/care/packages/${slugOf(p.code)}`, label: `Package: ${p.name}` })),
  ];
  const page = pages.find((p) => p.value === sp.page)?.value ?? '/';
  const source = tag(sp.source) || 'whatsapp';
  const campaign = tag(sp.campaign);
  const link = `${s.canonicalOrigin}${page}?${new URLSearchParams({ utm_source: source, ...(campaign ? { utm_campaign: campaign } : {}) })}`;
  const gbp = (b: PublicBranch) => `${s.canonicalOrigin}/care/branches/${b.slug}?utm_source=google-business&utm_campaign=${b.slug}`;
  const description = s.branding.branding.description ?? '';

  return (
    <ZoneFrame zone="admin" path="/admin/seo" zones={ZONES}>
      <PageHeader title="Search and ads" subtitle="How patients find you on Google and through your own campaigns, and what bookings each link brings." />
      <Flash ok={sp.ok} error={sp.error} />

      <span id="about" />
      <Card title="How search engines describe you">
        <p className="mc-meta" style={{ marginTop: 0 }}>Your public pages (home, branches, doctors, specialties, tests and packages) are listed in <a href={`${s.origin}/sitemap.xml`}>your sitemap</a> for search engines{s.indexable ? '' : ': not while the hospital is offline'}. Staff and patient pages never are.</p>
        <form action={saveDescription} className="mc-form" aria-label="Hospital description">
          <label className="mc-field mc-field-wide"><span>About {s.name} (home page and search results)</span>
            <textarea name="description" rows={3} maxLength={300} defaultValue={description} placeholder="A 120-bed multi-specialty hospital in Noida with 24×7 emergency, cardiology, orthopaedics and a NABL-accredited lab." />
          </label>
          <Button>Save description</Button>
        </form>
        <p className="mc-meta" style={{ marginBottom: 0 }}>{description.length} of 300 characters; search results show about the first 155. Say what you are, where, and what you are known for, and only what is true.</p>
      </Card>

      <span id="branches" />
      <Card title="Branches">
        <Table rows={branches.filter((b) => b.active)} empty="No branches yet." columns={[
          { header: 'Branch', cell: (b) => <><strong>{b.name}</strong>{slug.get(b.id) ? <div className="mc-meta"><a href={`${s.origin}/care/branches/${slug.get(b.id)}`}>/care/branches/{slug.get(b.id)}</a></div> : null}</> },
          { header: 'Area it serves', cell: (b) => (
            <form action={saveArea} className="mc-inline" aria-label={`Area of ${b.name}`}>
              <input type="hidden" name="id" value={b.id} /><input type="hidden" name="version" value={b.version} />
              <input name="area" defaultValue={b.area ?? ''} placeholder={`e.g. Sector 62, ${b.city}`} maxLength={80} className="mc-input-sm" aria-label="Area" />
              <button className="mc-btn mc-btn-ghost">Save</button>
            </form>
          ) },
        ]} />
        <p className="mc-meta" style={{ marginBottom: 0 }}>The area goes into the branch page&apos;s title, so &quot;hospital in Sector 62&quot; finds it. Renaming a branch keeps its old address working (it forwards to the new one).</p>
      </Card>

      {directory ? (
        <Card title="Doctors' profiles">
          <Table rows={doctors.items.map((d) => ({ d, gaps: profileGaps(d) })).sort((a, b) => b.gaps.length - a.gaps.length)} empty="No doctors yet." columns={[
            { header: 'Doctor', cell: ({ d }) => <><a href={`/admin/doctors/${d.id}`}><strong>{d.name}</strong></a>{d.slug && d.status === 'ACTIVE' ? <div className="mc-meta"><a href={`${s.origin}/care/doctors/${d.slug}`}>public page</a></div> : null}</> },
            { header: 'What is missing', cell: ({ gaps }) => (gaps.length ? gaps.map((g) => <Badge key={g} tone={g === 'not published' ? 'danger' : 'warning'}>{g}</Badge>) : <Badge tone="success">complete</Badge>) },
          ]} />
          <p className="mc-meta" style={{ marginBottom: 0 }}>Patients choose doctors by photo, qualifications, experience and languages; search engines show the same. A full profile is the cheapest advertising you have.</p>
        </Card>
      ) : null}

      <span id="links" />
      <Card title="Campaign links">
        <p className="mc-meta" style={{ marginTop: 0 }}>Share a page with a campaign tag (on WhatsApp, posters with a QR code, your Google Business Profile). Bookings made within 30 days of opening the link count for that campaign.</p>
        <form method="get" action="/admin/seo#links" className="mc-form" aria-label="Make a campaign link">
          <label className="mc-field"><span>Page</span><select name="page" defaultValue={page}>{pages.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select></label>
          <label className="mc-field"><span>Where you will share it</span><input name="source" list="mc-sources" defaultValue={source} maxLength={50} /></label>
          <datalist id="mc-sources">{SOURCES.map((x) => <option key={x} value={x} />)}</datalist>
          <label className="mc-field"><span>Campaign name</span><input name="campaign" defaultValue={campaign} placeholder="diwali-heart-checkup" maxLength={50} /></label>
          <Button>Make the link</Button>
        </form>
        <p style={{ marginBottom: 0 }}><strong>Your link:</strong> <code style={{ wordBreak: 'break-all' }}>{link}</code></p>
      </Card>

      <Card title="Bookings by campaign link (last 30 days)">
        {!analytics ? <p className="mc-meta" style={{ margin: 0 }}>Shown with the Analytics module. Bookings still record their campaign, so the numbers are there once it is on.</p>
          : !byCampaign ? <p className="mc-meta" style={{ margin: 0 }}>Analytics is not answering right now; try again in a minute.</p>
          : (
            <Table rows={byCampaign.rows} empty="No bookings in the last 30 days." columns={[
              { header: 'Source / campaign', cell: (r) => (r.key === '(none)' || r.key == null ? <span className="mc-meta">no campaign link</span> : r.label) },
              { header: 'Appointments', cell: (r) => r.value ?? 0 },
            ]} />
          )}
      </Card>

      <Card title="Google Business Profile checklist">
        <ol style={{ margin: 0, paddingLeft: 20 }}>
          <li>One profile per branch at <a href="https://business.google.com" rel="noopener" target="_blank">business.google.com</a>, verified, with the same name and address as on your site.</li>
          <li>Primary category (&quot;Hospital&quot;, &quot;Medical clinic&quot;, &quot;Medical laboratory&quot;), opening hours, phone, and photos of the entrance and reception.</li>
          <li>Set each profile&apos;s <strong>website</strong> and <strong>appointment link</strong> to its branch page with a campaign tag, so its bookings show above:
            <ul>{pub.map((b) => <li key={b.id}><code style={{ wordBreak: 'break-all' }}>{gbp(b)}</code></li>)}</ul>
          </li>
          <li>Ask patients for reviews after the visit, and reply to every review without mentioning anyone&apos;s health (a reply is public).</li>
          <li>Doctors who see patients at several branches: a profile per practitioner is optional; keep it consistent with the doctor&apos;s page here.</li>
        </ol>
      </Card>

      <Card title="Rules for medical advertising in India">
        <p className="mc-meta" style={{ marginTop: 0 }}>Your hospital is responsible for its own ads. Before you publish one, check it against:</p>
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          <li><strong>Drugs and Magic Remedies (Objectionable Advertisements) Act, 1954:</strong> no claims to cure or treat the diseases it lists, and no &quot;guaranteed&quot; results.</li>
          <li><strong>NMC professional-conduct rules:</strong> limits on what individual doctors may advertise about themselves; no testimonials or claims of superiority.</li>
          <li><strong>Google and Meta healthcare ad policies:</strong> some treatments need certification, and ads may not target people by a health condition.</li>
          <li><strong>Patients&apos; privacy (DPDP Act):</strong> never upload patient lists to ad platforms and never put ad pixels on patient pages. MediCare does neither; campaign links are measured inside your own analytics.</li>
          <li>Prices in ads must match your site; packages here always show the live price.</li>
        </ul>
        <p className="mc-meta" style={{ marginBottom: 0 }}>A summary, not legal advice: ask your legal adviser when in doubt.</p>
      </Card>
    </ZoneFrame>
  );
}
