import { getSession } from '@mc/auth';
import { api } from '@mc/bff';
import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { Badge, Button, Card, Chip, PageHeader } from '@mc/ui';
import { closeChatRequest } from '@/lib/actions';
import { Flash } from '@/lib/flash';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

interface ChatRequest {
  id: string; name: string; phone: string | null; reason: string; status: string; createdAt: string; closedAt: string | null; note: string | null;
  transcript: { role: 'user' | 'assistant'; kind: string; text: string; at: string }[];
}
const REASON: Record<string, string> = { ASKED: 'Asked for a person', NO_ANSWER: 'Assistant did not know', EMERGENCY: 'Emergency', LIMIT: 'Assistant limit reached', FALLBACK: 'Assistant unavailable', BLOCKED: 'Medical question' };
const when = (d: string) => new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(new Date(d));

/** Patients who asked the AI assistant for a person: call them back, then close the request. */
export default async function ChatRequests({ searchParams }: { searchParams: Promise<{ status?: string; ok?: string; error?: string }> }) {
  await zoneCapabilities('desk', '/desk/assistant');
  const { accessToken: token } = (await getSession())!;
  const sp = await searchParams;
  const status = sp.status === 'DONE' ? 'DONE' : 'OPEN';
  const rows = await api<ChatRequest[]>(`/api/assistant/v1/assistant/handoffs?status=${status}`, { token });
  return (
    <ZoneFrame zone="desk" path="/desk/assistant" zones={ZONES}>
      <PageHeader title="Chat requests" subtitle="Patients who asked the assistant for a person. Call them back, then close the request." />
      <Flash ok={sp.ok} error={sp.error} />
      <nav className="mc-chips" aria-label="Status">
        <Chip href="/desk/assistant" active={status === 'OPEN'}>Waiting</Chip>
        <Chip href="/desk/assistant?status=DONE" active={status === 'DONE'}>Closed</Chip>
      </nav>
      <section className="mc-list" aria-label="Chat requests">
        {rows.length ? rows.map((h) => (
          <Card key={h.id}>
            <article aria-label={`Chat request from ${h.name}`}>
              <div className="mc-page-header">
                <div>
                  <h2 style={{ margin: 0 }}>{h.name}</h2>
                  <p className="mc-muted">{h.phone ? <a href={`tel:${h.phone}`}>{h.phone}</a> : 'No phone number'} · {when(h.createdAt)}</p>
                </div>
                <Badge tone={h.reason === 'EMERGENCY' ? 'danger' : 'warning'}>{REASON[h.reason] ?? h.reason}</Badge>
              </div>
              <details style={{ marginTop: 12 }}>
                <summary>Conversation ({h.transcript.length} messages)</summary>
                <ol className="mc-chat-log" style={{ listStyle: 'none', minHeight: 0, marginTop: 8 }}>
                  {h.transcript.map((m, i) => (
                    <li key={i} className={`mc-chat-msg mc-chat-${m.role}`}><div className="mc-chat-bubble">{m.text}</div></li>
                  ))}
                </ol>
              </details>
              {h.status === 'OPEN' ? (
                <form action={closeChatRequest} className="mc-form" style={{ marginTop: 12 }}>
                  <input type="hidden" name="id" value={h.id} />
                  <input type="hidden" name="back" value="/desk/assistant" />
                  <label className="mc-field mc-field-wide"><span>Note (optional)</span><input name="note" maxLength={500} placeholder="e.g. Called back, booked for Monday" /></label>
                  <Button>Called back, close</Button>
                </form>
              ) : <p className="mc-muted">Closed {h.closedAt ? when(h.closedAt) : ''}{h.note ? `: ${h.note}` : ''}</p>}
            </article>
          </Card>
        )) : <p className="mc-muted">{status === 'OPEN' ? 'No one is waiting for a call back.' : 'No closed requests yet.'}</p>}
      </section>
    </ZoneFrame>
  );
}
