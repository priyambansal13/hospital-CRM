'use client';
/**
 * The assistant chat panel (docs/AI-AGENTS.md §2: shared by the patient zone now, the doctor zone's copilot later).
 * A client component: the zone passes server actions, so API calls and the user's token stay on the server.
 * Emergencies are shown as a fixed alert with call buttons; "Talk to a person" is always one tap away.
 */
import { useEffect, useRef, useState } from 'react';

export interface ChatMessage {
  id: string; role: 'user' | 'assistant';
  kind: 'TEXT' | 'ANSWER' | 'EMERGENCY' | 'BLOCKED' | 'FALLBACK' | 'HANDOFF' | 'LIMIT';
  text: string; sources: { id: string; title: string }[]; offerHandoff: boolean; emergency: string | null; createdAt: string;
}
export interface Handoff { id: string; status: string; phone: string | null }
export interface Conversation { id: string; status: string; handoff: Handoff | null }

type Err = { error: string };
export interface ChatActions {
  send: (conversationId: string | null, text: string) => Promise<{ conversationId: string; userMessageId: string; message: ChatMessage } | Err>;
  handoff: (conversationId: string, reason: string) => Promise<{ handoff: Handoff; message: ChatMessage | null } | Err>;
  feedback: (messageId: string, rating: 1 | -1) => Promise<{ ok: true } | Err>;
  close: (conversationId: string) => Promise<{ ok: true } | Err>;
}

const SUGGESTIONS = ['What are the visiting hours?', 'Do I need to fast before a blood test?', 'Is parking available?', 'मिलने का समय क्या है?'];
const isErr = (x: unknown): x is Err => !!x && typeof x === 'object' && 'error' in x;

function Emergency({ m }: { m: ChatMessage }) {
  const lines = m.text.split('\n');
  const selfHarm = m.emergency === 'SELF_HARM';
  return (
    <div className="mc-chat-emergency" role="alert">
      <strong>{lines[0]}</strong>
      {lines.slice(1).map((l, i) => <p key={i}>{l}</p>)}
      <div className="mc-chat-calls">
        <a className="mc-btn mc-btn-danger" href="tel:112">Call 112</a>
        <a className="mc-btn mc-btn-ghost" href="tel:108">Ambulance 108</a>
        {selfHarm ? <a className="mc-btn mc-btn-ghost" href="tel:14416">Tele-MANAS 14416</a> : null}
      </div>
    </div>
  );
}

export function ChatPanel({ hospital, initial, actions }: { hospital: string; initial: { conversation: Conversation | null; messages: ChatMessage[] }; actions: ChatActions }) {
  const [conversation, setConversation] = useState<Conversation | null>(initial.conversation);
  const [messages, setMessages] = useState<ChatMessage[]>(initial.messages);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rated, setRated] = useState<Record<string, 1 | -1>>({});
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  // newest message in view (an emergency's call buttons must never be below the fold)
  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, busy]);
  const handedOff = !!conversation?.handoff && conversation.handoff.status === 'OPEN';

  const send = async (text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    setError(null);
    const pending: ChatMessage = { id: `pending-${Date.now()}`, role: 'user', kind: 'TEXT', text: t, sources: [], offerHandoff: false, emergency: null, createdAt: new Date().toISOString() };
    setMessages((m) => [...m, pending]);
    if (input.current) input.current.value = '';
    const r = await actions.send(conversation?.id ?? null, t);
    setBusy(false);
    if (isErr(r)) {
      setMessages((m) => m.filter((x) => x.id !== pending.id));
      if (input.current) input.current.value = t;
      return setError(r.error);
    }
    if (!conversation) setConversation({ id: r.conversationId, status: 'OPEN', handoff: null });
    setMessages((m) => [...m.map((x) => (x.id === pending.id ? { ...x, id: r.userMessageId } : x)), r.message]);
  };

  const handoff = async (reason: string) => {
    if (!conversation || busy) return;
    setBusy(true);
    const r = await actions.handoff(conversation.id, reason);
    setBusy(false);
    if (isErr(r)) return setError(r.error);
    setConversation({ ...conversation, status: 'HANDED_OFF', handoff: r.handoff });
    if (r.message) setMessages((m) => [...m, r.message!]);
  };

  const rate = async (id: string, rating: 1 | -1) => {
    setRated((x) => ({ ...x, [id]: rating }));
    await actions.feedback(id, rating);
  };

  const restart = async () => {
    if (conversation) await actions.close(conversation.id);
    setConversation(null);
    setMessages([]);
    setError(null);
  };

  return (
    <section className="mc-chat" aria-label="Assistant chat">
      <p className="mc-chat-note">
        AI assistant: answers come from {hospital}&apos;s own information. It cannot give medical advice. In an emergency, call 112.
      </p>
      <div ref={log} className="mc-chat-log" role="log" aria-live="polite" aria-label="Messages">
        {messages.length === 0 ? (
          <div className="mc-chat-empty">
            <p>Ask about timings, visiting rules, payments, insurance or how to prepare for a test.</p>
            <div className="mc-chips">{SUGGESTIONS.map((s) => <button key={s} type="button" className="mc-chip" onClick={() => void send(s)}>{s}</button>)}</div>
          </div>
        ) : null}
        {messages.map((m) => (
          <div key={m.id} className={`mc-chat-msg mc-chat-${m.role}`} data-kind={m.kind}>
            {m.kind === 'EMERGENCY' ? <Emergency m={m} /> : <div className="mc-chat-bubble">{m.text}</div>}
            {m.sources.length ? <p className="mc-chat-meta">From: {m.sources.map((s) => s.title).join(', ')}</p> : null}
            {m.role === 'assistant' && m.kind === 'ANSWER' ? (
              <div className="mc-chat-rate" aria-label="Was this helpful?">
                <button type="button" aria-pressed={rated[m.id] === 1} aria-label="Helpful" onClick={() => void rate(m.id, 1)}>👍</button>
                <button type="button" aria-pressed={rated[m.id] === -1} aria-label="Not helpful" onClick={() => void rate(m.id, -1)}>👎</button>
              </div>
            ) : null}
            {m.offerHandoff && !handedOff ? <button type="button" className="mc-btn mc-btn-ghost mc-chat-handoff" onClick={() => void handoff(m.kind === 'ANSWER' ? 'NO_ANSWER' : m.kind)}>Talk to a person</button> : null}
          </div>
        ))}
        {busy ? <div className="mc-chat-msg mc-chat-assistant"><div className="mc-chat-bubble mc-chat-typing">Typing…</div></div> : null}
      </div>
      {error ? <p role="alert" className="mc-alert mc-alert-error">{error}</p> : null}
      {handedOff ? <p role="status" className="mc-alert mc-alert-success">The hospital will call you back{conversation?.handoff?.phone ? ` on ${conversation.handoff.phone}` : ''}.</p> : null}
      <form className="mc-chat-form" aria-label="Message the assistant" onSubmit={(e) => { e.preventDefault(); void send(input.current?.value ?? ''); }}>
        <textarea ref={input} name="text" rows={2} maxLength={1000} placeholder="Type your question" aria-label="Your message"
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(e.currentTarget.value); } }} />
        <div className="mc-chat-actions">
          <button type="submit" className="mc-btn mc-btn-primary" disabled={busy}>Send</button>
          {conversation && !handedOff ? <button type="button" className="mc-btn mc-btn-ghost" disabled={busy} onClick={() => void handoff('ASKED')}>Talk to a person</button> : null}
          {conversation ? <button type="button" className="mc-btn mc-btn-ghost" disabled={busy} onClick={() => void restart()}>New chat</button> : null}
        </div>
      </form>
    </section>
  );
}
