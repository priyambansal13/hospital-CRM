'use client';
import { useEffect, useState } from 'react';

interface Summary { open: number; emergency: number; oldestMinutes: number | null }

/**
 * Patients waiting for a call back after asking the AI assistant for a person (review: desk alerts for chat requests).
 * Polls every 20 seconds; an emergency is shown in red. The tab title carries the count so it is seen from other tabs.
 */
export function ChatAlert({ initial }: { initial: Summary }) {
  const [s, setS] = useState(initial);
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\) /, '');
    document.title = s.open ? `(${s.open}) ${base}` : base;
  }, [s.open]);
  useEffect(() => {
    const t = setInterval(() => {
      fetch('/desk/chat-alerts', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((j: Summary | null) => { if (j) setS(j); }).catch(() => undefined);
    }, 20_000);
    return () => clearInterval(t);
  }, []);
  if (!s.open) return null;
  const urgent = s.emergency > 0;
  return (
    <div role="alert" className={`mc-alert ${urgent ? 'mc-alert-error' : 'mc-alert-info'}`} data-testid="chat-alert">
      {urgent ? <strong>{s.emergency} emergency chat request{s.emergency > 1 ? 's' : ''}. </strong> : null}
      {s.open} patient{s.open > 1 ? 's' : ''} waiting for a call back{s.oldestMinutes ? ` (longest ${s.oldestMinutes} min)` : ''}. <a href="/desk/assistant">Open chat requests</a>
    </div>
  );
}
