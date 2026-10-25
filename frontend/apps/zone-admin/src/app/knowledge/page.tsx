import { getSession } from '@mc/auth';
import { api, ApiError } from '@mc/bff';
import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { Badge, Button, Card, PageHeader, Select } from '@mc/ui';
import { Flash } from '@/lib/flash';
import { ZONES } from '@/lib/zones';
import { addArticle, deleteArticle, saveArticle } from './actions';

export const dynamic = 'force-dynamic';

interface Article { id: string; source: string; title: string; body: string; language: string; active: boolean; version: number; editable: boolean; updatedAt: string }
interface Hit { articleId: string; title: string; source: string; text: string; score: number }
const SOURCE: Record<string, string> = { EMERGENCY: 'Emergency', FAQ: 'Questions', POLICY: 'Policies', TEST_PREP: 'Test preparation (from the lab catalog)' };

function Editor({ a }: { a: Article }) {
  return (
    <details>
      <summary><strong>{a.title}</strong> {a.active ? null : <Badge tone="warning">Off</Badge>} {a.language === 'hi' ? <Badge>Hindi</Badge> : null}</summary>
      <form action={saveArticle} className="mc-form" aria-label={`Edit ${a.title}`} style={{ marginTop: 8 }}>
        <input type="hidden" name="id" value={a.id} />
        <input type="hidden" name="version" value={a.version} />
        <label className="mc-field mc-field-wide"><span>Title</span><input name="title" defaultValue={a.title} required minLength={2} maxLength={200} /></label>
        <label className="mc-field mc-field-wide"><span>What the assistant should know</span><textarea name="body" defaultValue={a.body} rows={5} required maxLength={8000} /></label>
        <label className="mc-check"><input type="checkbox" name="active" defaultChecked={a.active} /> Assistant uses this</label>
        <Button>Save</Button>
      </form>
      {a.source !== 'EMERGENCY' ? (
        <form action={deleteArticle} style={{ marginTop: 8 }}>
          <input type="hidden" name="id" value={a.id} /><input type="hidden" name="title" value={a.title} />
          <Button variant="ghost">Delete</Button>
        </form>
      ) : null}
    </details>
  );
}

/**
 * What the patients' AI assistant answers from (docs/AI-AGENTS.md §4). Hospital facts only; the assistant refuses
 * medical advice even if it is written here, and saving advice is refused with the reason.
 */
export default async function Knowledge({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string; q?: string }> }) {
  await zoneCapabilities('admin', '/admin/knowledge');
  const { accessToken: token } = (await getSession())!;
  const sp = await searchParams;
  const articles = await api<Article[]>('/api/assistant/v1/assistant/knowledge', { token });
  let tried: { query: string; hits: Hit[] } | null = null;
  let tryError: string | undefined;
  if (sp.q?.trim()) {
    try {
      tried = await api(`/api/assistant/v1/assistant/knowledge/search?q=${encodeURIComponent(sp.q.trim())}`, { token });
    } catch (e) {
      tryError = e instanceof ApiError ? e.message : 'Could not search';
    }
  }
  const groups = ['EMERGENCY', 'FAQ', 'POLICY', 'TEST_PREP'].map((s) => ({ source: s, items: articles.filter((a) => a.source === s) }));
  return (
    <ZoneFrame zone="admin" path="/admin/knowledge" zones={ZONES}>
      <PageHeader title="Assistant knowledge" subtitle="What the AI assistant tells patients about your hospital. Keep it to facts: timings, rules, payments, preparation." />
      <Flash ok={sp.ok} error={sp.error ?? tryError} />
      <Card>
        <h2>Try a question</h2>
        <form method="get" className="mc-form" aria-label="Try a question">
          <label className="mc-field mc-field-wide"><span>A question a patient might ask</span><input name="q" defaultValue={sp.q ?? ''} placeholder="When can I visit my father in the ICU?" /></label>
          <Button variant="ghost">Show what the assistant finds</Button>
        </form>
        {tried ? (
          <ol aria-label="What the assistant finds" style={{ marginTop: 12 }}>
            {tried.hits.length ? tried.hits.map((h) => <li key={h.articleId}><strong>{h.title}</strong> <span className="mc-meta">{SOURCE[h.source]}</span><br /><span className="mc-muted">{h.text.slice(0, 160)}{h.text.length > 160 ? '…' : ''}</span></li>)
              : <li>Nothing matches: the assistant would say it does not know and offer a call back. Add an article below.</li>}
          </ol>
        ) : null}
      </Card>
      {groups.map((g) => (
        <Card key={g.source}>
          <h2>{SOURCE[g.source]} <span className="mc-meta">({g.items.length})</span></h2>
          {g.source === 'TEST_PREP'
            ? <p className="mc-muted">Change preparation in <a href="/admin/lab-catalog">Lab catalog</a>; the assistant picks it up within 30 minutes. {g.items.map((a) => a.title.replace(/: how to prepare$/, '')).join(', ') || 'No lab module.'}</p>
            : <div className="mc-list">{g.items.map((a) => <Editor key={a.id} a={a} />)}</div>}
        </Card>
      ))}
      <Card>
        <h2>Add an article</h2>
        <form action={addArticle} className="mc-form" aria-label="New article">
          <Select label="Kind" name="source" options={[{ value: 'FAQ', label: 'Question' }, { value: 'POLICY', label: 'Policy' }]} />
          <Select label="Language" name="language" options={[{ value: 'en', label: 'English' }, { value: 'hi', label: 'Hindi' }]} />
          <label className="mc-field mc-field-wide"><span>Title</span><input name="title" required minLength={2} maxLength={200} placeholder="Pharmacy timings" /></label>
          <label className="mc-field mc-field-wide"><span>What the assistant should know</span><textarea name="body" rows={4} required maxLength={8000} placeholder="The pharmacy on the ground floor is open 24 hours." /></label>
          <Button>Add</Button>
        </form>
      </Card>
    </ZoneFrame>
  );
}
