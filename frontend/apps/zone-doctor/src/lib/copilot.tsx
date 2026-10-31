import { api } from '@mc/bff';
import { Badge, Button, Card, Field, Select } from '@mc/ui';
import { makeSummary, rateSummary } from './copilot-actions';

interface Source { ref: string; type: 'ENCOUNTER' | 'PRESCRIPTION' | 'ALLERGY' | 'LAB_REPORT' | 'TRIAGE'; id: string; date: string | null }
interface Draft {
  id: string; patientId: string; createdAt: string; model: string | null; droppedLines: number;
  sections: { title: string; lines: { text: string; refs: string[] }[] }[]; sources: Source[]; feedback: { rating: 1 | -1; reason: string | null } | null;
}

const LABEL: Record<Source['type'], string> = { ENCOUNTER: 'Visit', PRESCRIPTION: 'Prescription', ALLERGY: 'Allergy', LAB_REPORT: 'Lab report', TRIAGE: 'Triage today' };
/** Where a citation opens: the record itself, so the doctor can check the line. */
function href(s: Source, patientId: string) {
  switch (s.type) {
    case 'ENCOUNTER': return `/doctor/patients/${patientId}#enc-${s.id}`;
    case 'PRESCRIPTION': return `/doctor/prescriptions/${s.id}/pdf`;
    case 'LAB_REPORT': return `/doctor/lab-results/${s.id}`;
    case 'ALLERGY': return '#allergies';
    default: return null;
  }
}

/**
 * The doctor's copilot (Phase 24): a pre-visit summary from the record, every line with links to the records it came
 * from. A draft for the doctor's eyes only: it is never written into the visit notes.
 */
export async function CopilotPanel({ token, appointmentId, back }: { token: string; appointmentId: string; back: string }) {
  const { summary: d } = await api<{ summary: Draft | null }>(`/api/assistant/v1/assistant/copilot/appointments/${appointmentId}/summary`, { token }).catch(() => ({ summary: null }));
  const byRef = new Map((d?.sources ?? []).map((s) => [s.ref, s]));
  return (
    <Card title="Copilot: pre-visit summary">
      <p className="mc-meta" style={{ marginTop: 0 }}>AI draft from this patient&apos;s record. Check the linked records before relying on a line; it is not added to the visit notes.</p>
      {d ? (
        <div className="mc-copilot" aria-label="Pre-visit summary">
          {d.sections.length ? d.sections.map((s) => (
            <section key={s.title}>
              <h3>{s.title}</h3>
              <ul>
                {s.lines.map((l, i) => (
                  <li key={i}>
                    {l.text}{' '}
                    {l.refs.map((r) => {
                      const src = byRef.get(r);
                      const to = src ? href(src, d.patientId) : null;
                      const label = src ? `${LABEL[src.type]}${src.date ? ` ${src.date}` : ''}` : r;
                      return to ? <a key={r} className="mc-cite" href={to} title={label}>[{label}]</a> : <span key={r} className="mc-cite" title={label}>[{label}]</span>;
                    })}
                  </li>
                ))}
              </ul>
            </section>
          )) : <p className="mc-empty">Nothing earlier on record for this patient.</p>}
          <p className="mc-meta">Made {new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(d.createdAt))}{d.droppedLines ? ` · ${d.droppedLines} line(s) left out: they did not match the record` : ''}</p>
          {d.feedback ? (
            <p className="mc-meta"><Badge tone={d.feedback.rating === 1 ? 'success' : 'warning'}>{d.feedback.rating === 1 ? 'Marked useful' : `Marked: ${(d.feedback.reason ?? 'not useful').toLowerCase().replace('_', ' ')}`}</Badge></p>
          ) : (
            <div className="mc-copilot-rate">
              <form action={rateSummary}>
                <input type="hidden" name="draftId" value={d.id} /><input type="hidden" name="back" value={back} /><input type="hidden" name="rating" value="1" />
                <Button variant="ghost">Useful</Button>
              </form>
              <form action={rateSummary} className="mc-form">
                <input type="hidden" name="draftId" value={d.id} /><input type="hidden" name="back" value={back} /><input type="hidden" name="rating" value="-1" />
                <Select label="What was wrong?" name="reason" options={[{ value: 'WRONG', label: 'Something is wrong' }, { value: 'MISSING', label: 'Something is missing' }, { value: 'NOT_USEFUL', label: 'Not useful' }, { value: 'TOO_LONG', label: 'Too long' }, { value: 'OTHER', label: 'Other' }]} />
                <Field label="Comment (optional)" name="comment" />
                <Button variant="ghost">Send feedback</Button>
              </form>
            </div>
          )}
        </div>
      ) : null}
      <form action={makeSummary}>
        <input type="hidden" name="appointmentId" value={appointmentId} /><input type="hidden" name="back" value={back} />
        <Button variant={d ? 'ghost' : 'primary'}>{d ? 'Make it again' : 'Make pre-visit summary'}</Button>
      </form>
    </Card>
  );
}
