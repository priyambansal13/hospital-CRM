'use client';
/**
 * The interactive parts of the frame: the command palette (Ctrl/⌘ K: jump to any screen you may open), the light /
 * dark switch (remembered in this browser), and the menu button that opens the sidebar on small screens.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './icons.js';

export interface PaletteItem { label: string; href: string; group: string; icon: string }

export function CommandPalette({ items }: { items: PaletteItem[] }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen((o) => !o); }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => { if (open) { setQ(''); setAt(0); setTimeout(() => input.current?.focus(), 0); } }, [open]);
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (t ? items.filter((i) => `${i.label} ${i.group}`.toLowerCase().includes(t)) : items).slice(0, 12);
  }, [q, items]);
  return (
    <>
      <button type="button" className="mc-search-btn" onClick={() => setOpen(true)} aria-label="Go to a screen (Ctrl+K)">
        <Icon name="search" size={16} /><span>Go to…</span><kbd>Ctrl K</kbd>
      </button>
      {open ? (
        <div className="mc-palette-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
          <div className="mc-palette" role="dialog" aria-label="Go to a screen">
            <input
              ref={input} value={q} placeholder="Type a screen: doctors, invoices, worklist…" aria-label="Screen name"
              onChange={(e) => { setQ(e.target.value); setAt(0); }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setAt((a) => Math.min(a + 1, shown.length - 1)); }
                if (e.key === 'ArrowUp') { e.preventDefault(); setAt((a) => Math.max(a - 1, 0)); }
                if (e.key === 'Enter' && shown[at]) window.location.href = shown[at].href;
              }}
            />
            {shown.length ? (
              <ul role="listbox" aria-label="Screens">
                {shown.map((i, n) => (
                  <li key={i.href} role="option" aria-selected={n === at} onMouseEnter={() => setAt(n)}>
                    <a href={i.href}><Icon name={i.icon} size={18} />{i.label}<small>{i.group}</small></a>
                  </li>
                ))}
              </ul>
            ) : <p className="mc-palette-empty">No screen called “{q}”.</p>}
          </div>
        </div>
      ) : null}
    </>
  );
}

export function ThemeToggle() {
  const [dark, setDark] = useState<boolean | null>(null);
  useEffect(() => {
    const set = document.documentElement.dataset.theme;
    setDark(set ? set === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches);
  }, []);
  const flip = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.dataset.theme = next ? 'dark' : 'light';
    try { localStorage.setItem('mc-theme', next ? 'dark' : 'light'); } catch { /* private mode */ }
  };
  return (
    <button type="button" className="mc-icon-btn" onClick={flip} aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'} title={dark ? 'Light mode' : 'Dark mode'}>
      <Icon name={dark ? 'sun' : 'moon'} />
    </button>
  );
}

/** Opens and closes the sidebar on small screens (the shell carries data-nav). */
export function NavToggle() {
  return (
    <button type="button" className="mc-icon-btn mc-menu-btn" aria-label="Menu" onClick={(e) => {
      const shell = (e.currentTarget as HTMLElement).closest('.mc-shell') as HTMLElement | null;
      if (!shell) return;
      shell.dataset.nav = shell.dataset.nav === 'open' ? '' : 'open';
      const close = (ev: MouseEvent) => { if (!(ev.target as HTMLElement).closest('.mc-sidebar, .mc-menu-btn')) { shell.dataset.nav = ''; document.removeEventListener('click', close); } };
      setTimeout(() => document.addEventListener('click', close), 0);
    }}>
      <Icon name="menu" />
    </button>
  );
}
