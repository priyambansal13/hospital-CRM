'use client';
/**
 * Live updates for queue screens: listens to a zone's /live stream (server-sent events from the realtime gateway)
 * and re-renders the page's server components when something changes. Falls back to polling if the stream drops.
 */
import { useRouter } from 'next/navigation.js';
import { useEffect, useRef, useState } from 'react';

export function LiveRefresh({ src, pollMs = 20_000 }: { src: string; pollMs?: number }) {
  const router = useRouter();
  const [state, setState] = useState<'connecting' | 'live' | 'offline'>('connecting');
  const [last, setLast] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let es: EventSource | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    let first = true;
    const refresh = () => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => router.refresh(), 150);
    };
    const connect = () => {
      es = new EventSource(src);
      es.addEventListener('ready', () => {
        setState('live');
        if (poll) { clearInterval(poll); poll = undefined; }
        if (!first) refresh(); // caught up after a reconnect: we may have missed changes
        first = false;
      });
      es.addEventListener('queue', (e) => {
        try {
          const s = JSON.parse((e as MessageEvent).data) as { type: string; tokenNo: number | null };
          setLast(`${s.type.replace('scheduling.appointment_', '').replace('_', ' ')}${s.tokenNo ? ` · token ${s.tokenNo}` : ''}`);
        } catch { /* signal only */ }
        refresh();
      });
      es.onerror = () => {
        setState('offline');
        if (!poll) poll = setInterval(() => router.refresh(), pollMs);
      };
    };
    connect();
    return () => { es?.close(); if (poll) clearInterval(poll); clearTimeout(timer.current); };
  }, [src, pollMs, router]);

  return (
    <span className="mc-live" data-state={state} role="status" aria-live="polite">
      {state === 'live' ? 'Live' : state === 'offline' ? 'Reconnecting…' : 'Connecting…'}
      {last ? <span className="mc-muted" style={{ margin: 0 }}> · last: {last}</span> : null}
    </span>
  );
}
