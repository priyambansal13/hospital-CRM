import { getSession } from '@mc/auth';
import { api } from '@mc/bff';
import { can, hasFeature, ZoneFrame, zoneCapabilities } from '@mc/features';
import { Badge, Bars, Button, Card, PageHeader, Table } from '@mc/ui';
import { Flash } from '@/lib/flash';
import { ZONES } from '@/lib/zones';
import { fmt, type Unit } from '../analytics/lib';
import { ask, draftWording, rate, remakeBrief, runRule, saveWording } from './actions';

export const dynamic = 'force-dynamic';

interface OpsTable { title: string; unit: Unit; from: string; to: string; groupLabel: string | null; value: number | null; rows: { label: string; value: number | null }[] }
interface Question { id: string; question: string; answer: string; tables: OpsTable[]; verified: boolean; model: string; rating: number | null; createdAt: string }
interface Brief { id: string; branchId: string; branchName: string; day: string; headline: string; points: string[]; verified: boolean; createdAt: string }
interface Gap { rule: string; label: string; testName: string; status: string; subject: string | null; body: string | null; source: string | null; note: string | null; version: number; lastRun: { candidates: number; nudged: number; started_at: string } | null; sent: number }

const SUGGESTED = [
  'Which department had the worst no-show rate last month, by weekday?',
  'How full were the doctors last week, by doctor?',
  'Revenue by branch this month',
  'How long do lab reports take, by week?',
];
const STATUS: Record<string, [string, 'success' | 'warning' | 'neutral']> = { APPROVED: ['Sending weekly', 'success'], DRAFT: ['Waiting for approval', 'warning'], DRAFTING: ['Drafting…', 'neutral'], OFF: ['Off', 'neutral'] };
const soft = <T,>(p: Promise<T>): Promise<T | null> => p.catch(() => null);
const when = (iso: string) => new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(iso));

function Answer({ q }: { q: Question }) {
  return (
    <Card title={q.question}>
      <p style={{ marginTop: 0, whiteSpace: 'pre-wrap' }}>{q.answer}</p>
      <p className="mc-meta">{q.verified ? 'Every figure was checked against the reports.' : 'Figures shown straight from the reports.'} {when(q.createdAt)}</p>
      {q.tables.map((t, i) => (
        <div key={i} style={{ marginTop: 16 }}>
          <h3 style={{ fontSize: '1rem', margin: '0 0 8px' }}>{t.title} <span className="mc-meta">({t.from} to {t.to})</span></h3>
          {t.groupLabel ? (
            <>
              <Bars rows={t.rows.filter((r) => r.value != null).map((r) => ({ label: r.label, value: r.value!, display: fmt(r.value, t.unit) }))} max={t.unit === 'percent' ? 100 : undefined} />
              <Table rows={t.rows} empty="No data." columns={[{ header: t.groupLabel, cell: (r) => r.label }, { header: t.title, cell: (r) => fmt(r.value, t.unit) }]} />
            </>
          ) : <p className="mc-kpi-value" style={{ margin: 0 }}>{fmt(t.value, t.unit)}</p>}
        </div>
      ))}
      {q.rating == null ? (
        <form action={rate} className="mc-inline" style={{ marginTop: 12 }}>
          <input type="hidden" name="id" value={q.id} />
          <button className="mc-btn mc-btn-ghost" name="rating" value="1">Helpful</button>
          <button className="mc-btn mc-btn-ghost" name="rating" value="-1">Not helpful</button>
        </form>
      ) : <p className="mc-meta" style={{ marginBottom: 0 }}>You rated this {q.rating > 0 ? 'helpful' : 'not helpful'}.</p>}
    </Card>
  );
}

/** Admin: ask about the hospital's numbers, read each branch's morning brief, approve care-gap reminders. */
export default async function Ops({ searchParams }: { searchParams: Promise<{ q?: string; ok?: string; error?: string }> }) {
  const caps = await zoneCapabilities('admin', '/admin/ops');
  const { accessToken: token } = (await getSession())!;
  const sp = await searchParams;
  const asks = can(caps, 'ops_agent:use:branch') && hasFeature(caps, 'ai_ops.agent');
  const gapsOn = can(caps, 'care_gap:manage:tenant') && hasFeature(caps, 'ai_ops.care_gaps');
  const [history, briefs, gaps] = await Promise.all([
    can(caps, 'ops_agent:use:branch') ? soft(api<Question[]>('/api/assistant/v1/assistant/ops/questions', { token })) : null,
    can(caps, 'ops_brief:receive:branch') ? soft(api<Brief[]>('/api/assistant/v1/assistant/ops/briefs', { token })) : null,
    gapsOn ? soft(api<Gap[]>('/api/assistant/v1/assistant/ops/care-gaps', { token })) : null,
  ]);
  const shown = history?.find((h) => h.id === sp.q) ?? history?.[0];

  return (
    <ZoneFrame zone="admin" path="/admin/ops" zones={ZONES} wide>
      <PageHeader title="Ops assistant" subtitle="Ask about your hospital's numbers in plain words. Answers come only from the analytics reports (no patient details), for the branches you manage." />
      <Flash ok={sp.ok} error={sp.error} />

      {asks ? (
        <Card title="Ask a question">
          <form action={ask} className="mc-form" style={{ maxWidth: 'none' }}>
            <label className="mc-field mc-field-wide"><span>Your question</span>
              <input name="question" required minLength={3} maxLength={500} placeholder="e.g. Which department had the worst no-show rate last month?" />
            </label>
            <Button>Ask</Button>
          </form>
          <nav className="mc-chips" aria-label="Suggested questions" style={{ marginTop: 12 }}>
            {SUGGESTED.map((s) => (
              <form key={s} action={ask} style={{ display: 'contents' }}><input type="hidden" name="question" value={s} /><button className="mc-chip" style={{ cursor: 'pointer', font: 'inherit' }}>{s}</button></form>
            ))}
          </nav>
        </Card>
      ) : null}
      <section id="answer">{shown ? <Answer q={shown} /> : null}</section>
      {history && history.length > 1 ? (
        <Card title="Earlier questions">
          <ul className="mc-list">{history.filter((h) => h.id !== shown?.id).slice(0, 10).map((h) => <li key={h.id}><a href={`/admin/ops?q=${h.id}#answer`}>{h.question}</a> <span className="mc-meta">{when(h.createdAt)}</span></li>)}</ul>
        </Card>
      ) : null}

      {briefs ? (
        <section id="briefs">
          <Card title="Morning briefs">
            {briefs.length ? (
              <div className="mc-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
                {briefs.map((b) => (
                  <article key={b.id} className="mc-card" aria-label={`Brief for ${b.branchName}`}>
                    <p className="mc-eyebrow" style={{ margin: 0 }}>{b.branchName} · {b.day}</p>
                    <p style={{ fontWeight: 700 }}>{b.headline}</p>
                    <ul>{b.points.map((p, i) => <li key={i}>{p}</li>)}</ul>
                    {hasFeature(caps, 'ai_ops.brief') ? <form action={remakeBrief}><input type="hidden" name="branchId" value={b.branchId} /><button className="mc-btn mc-btn-ghost">Write today&apos;s again</button></form> : null}
                  </article>
                ))}
              </div>
            ) : <p className="mc-empty">The first briefs arrive by e-mail at 7 a.m. branch time.</p>}
          </Card>
        </section>
      ) : null}

      {gaps ? (
        <section id="care-gaps">
          <Card title="Care-gap reminders">
            <p style={{ marginTop: 0 }}>Patients with a long-term condition who are due a routine test get a reminder once a week (at most once every 90 days each). Fixed rules decide who; the AI only drafts the wording, which never names the condition, and nothing is sent until you approve it. Placeholders: {'{{patientName}} {{hospital}} {{testName}} {{link}}'}.</p>
            <form action={draftWording}><button className="mc-btn mc-btn-ghost">Draft the wording again</button></form>
            {gaps.map((g) => (
              <form key={g.rule} action={saveWording} className="mc-form" style={{ maxWidth: 'none', borderTop: '1px solid var(--border)', paddingTop: 16, marginTop: 16 }} aria-label={g.label}>
                <p style={{ margin: 0 }}><strong>{g.label}</strong> <Badge tone={STATUS[g.status]?.[1] ?? 'neutral'}>{STATUS[g.status]?.[0] ?? g.status}</Badge></p>
                <p className="mc-meta" style={{ margin: 0 }}>
                  {g.source === 'AI' ? 'Drafted by AI. ' : g.source === 'EDITED' ? 'Edited by your team. ' : g.source === 'TEMPLATE' ? 'Standard wording. ' : ''}{g.note ? `${g.note}. ` : ''}
                  {g.lastRun ? `Last run ${when(g.lastRun.started_at)}: ${g.lastRun.candidates} due, ${g.lastRun.nudged} reminded. ` : ''}{g.sent ? `${g.sent} reminders sent in all.` : ''}
                </p>
                <input type="hidden" name="rule" value={g.rule} />
                <input type="hidden" name="version" value={g.version} />
                <label className="mc-field mc-field-wide"><span>Subject</span><input name="subject" defaultValue={g.subject ?? ''} disabled={g.status === 'DRAFTING'} /></label>
                <label className="mc-field mc-field-wide"><span>Message</span><textarea name="body" rows={3} defaultValue={g.body ?? ''} disabled={g.status === 'DRAFTING'} /></label>
                <div className="mc-inline">
                  <button className="mc-btn mc-btn-primary" name="status" value="APPROVED" disabled={g.status === 'DRAFTING'}>{g.status === 'APPROVED' ? 'Save' : 'Approve and send weekly'}</button>
                  {g.status !== 'OFF' ? <button className="mc-btn mc-btn-ghost" name="status" value="OFF">Switch off</button> : null}
                  {g.status === 'APPROVED' ? <button className="mc-btn mc-btn-ghost" formAction={runRule}>Send reminders now</button> : null}
                </div>
              </form>
            ))}
          </Card>
        </section>
      ) : null}
    </ZoneFrame>
  );
}
