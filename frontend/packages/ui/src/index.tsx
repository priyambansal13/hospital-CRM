/**
 * @mc/ui: MediCare design system (minimal M1 set). Theme tokens are CSS variables (theme.css); the hospital's
 * branding overrides --brand / --accent at the frame level.
 */
import type { CSSProperties, ReactNode } from 'react';

import { CommandPalette, NavToggle, ThemeToggle } from './shell.js';
import { Icon, iconFor } from './icons.js';

export { Icon, iconFor } from './icons.js';

export interface FrameNavItem { key: string; label: string; href: string; active?: boolean; /** the area it belongs to (sidebar group) */ group?: string }

/** Applies the remembered light/dark choice before the first paint (no flash). */
const THEME_SCRIPT = "try{var t=localStorage.getItem('mc-theme');if(t)document.documentElement.dataset.theme=t}catch(e){}";
const initials = (s: string) => s.replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';

/**
 * The page frame. Staff get a sidebar (their screens grouped by area, with icons), a top bar with the command palette
 * (Ctrl/⌘ K) and the light/dark switch; patients and visitors get a top bar and a footer.
 */
export function AppFrame(props: {
  hospital: { name: string; logoUrl?: string | null; primaryColor?: string; accentColor?: string };
  nav: FrameNavItem[];
  user?: { label: string; signOutHref: string; role?: string } | null;
  /** shown when nobody is signed in */
  signInHref?: string;
  homeHref?: string;
  /** 'sidebar' for staff with several areas */
  layout?: 'top' | 'sidebar';
  /** full-bleed pages (the home page) manage their own width */
  wide?: boolean;
  children: ReactNode;
}) {
  const style = { '--brand': props.hospital.primaryColor ?? '#0f766e', '--accent': props.hospital.accentColor ?? '#f59e0b' } as CSSProperties;
  const brand = (
    <a className="mc-brand" href={props.homeHref ?? '/'}>
      {props.hospital.logoUrl ? <img src={props.hospital.logoUrl} alt="" className="mc-logo" /> : <span className="mc-logo-mark" aria-hidden>{props.hospital.name.slice(0, 1)}</span>}
      <span>{props.hospital.name}</span>
    </a>
  );
  const script = <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />;
  if (props.layout === 'sidebar') {
    const groups: { title: string; items: FrameNavItem[] }[] = [];
    for (const n of props.nav) {
      const title = n.group ?? 'Menu';
      const g = groups.find((x) => x.title === title) ?? (groups.push({ title, items: [] }), groups.at(-1)!);
      g.items.push(n);
    }
    const current = props.nav.find((n) => n.active);
    return (
      <div className="mc-shell" style={style}>
        {script}
        <aside className="mc-sidebar" aria-label="Sidebar">
          {brand}
          <nav className="mc-side-nav" aria-label="Main">
            {groups.map((g) => (
              <div key={g.title} className="mc-side-group">
                <div className="mc-side-title">{g.title}</div>
                {g.items.map((n) => (
                  <a key={n.key} href={n.href} className={n.active ? 'active' : undefined} aria-current={n.active ? 'page' : undefined}>
                    <Icon name={iconFor(n.key, n.label)} />{n.label}
                  </a>
                ))}
              </div>
            ))}
          </nav>
          {props.user ? (
            <div className="mc-side-foot">
              <div className="mc-who">
                <span className="mc-initials" aria-hidden>{initials(props.user.label)}</span>
                <div style={{ minWidth: 0 }}><div className="mc-who-name">{props.user.label}</div><div className="mc-who-role">{props.user.role ?? 'Staff'}</div></div>
              </div>
              <a href={props.user.signOutHref} className="mc-btn mc-btn-ghost">Sign out</a>
            </div>
          ) : null}
        </aside>
        <div className="mc-content">
          <header className="mc-topbar">
            <NavToggle />
            <div className="mc-crumb">{current ? <>{current.group && current.group !== current.label ? `${current.group} / ` : ''}<strong>{current.label}</strong></> : <strong>{props.hospital.name}</strong>}</div>
            <CommandPalette items={props.nav.map((n) => ({ label: n.label, href: n.href, group: n.group ?? '', icon: iconFor(n.key, n.label) }))} />
            <ThemeToggle />
          </header>
          <main className={`mc-main${props.wide ? ' mc-main-wide' : ''}`}>{props.children}</main>
        </div>
      </div>
    );
  }
  return (
    <div className="mc-frame" style={style}>
      {script}
      <header className="mc-header">
        {brand}
        <nav className="mc-nav" aria-label="Main">
          {props.nav.map((n) => (
            <a key={n.key} href={n.href} className={n.active ? 'active' : undefined} aria-current={n.active ? 'page' : undefined}>{n.label}</a>
          ))}
        </nav>
        <ThemeToggle />
        {props.user ? (
          <div className="mc-user">
            <span>{props.user.label}</span>
            <a href={props.user.signOutHref} className="mc-btn mc-btn-ghost">Sign out</a>
          </div>
        ) : props.signInHref ? (
          <div className="mc-user"><a href={props.signInHref} className="mc-btn mc-btn-primary">Sign in</a></div>
        ) : null}
      </header>
      <main className={`mc-main${props.wide ? ' mc-main-wide' : ''}`}>{props.children}</main>
      <footer className="mc-footer">
        <div className="mc-footer-inner">
          <span>© {new Date().getFullYear()} {props.hospital.name}. In an emergency call <a href="tel:112">112</a> or <a href="tel:108">108</a> (ambulance).</span>
          <span>Powered by MediCare</span>
        </div>
      </footer>
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mc-page-header">
      <div>
        <h1>{title}</h1>
        {subtitle ? <p className="mc-muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="mc-actions">{actions}</div> : null}
    </div>
  );
}

export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="mc-card">
      {title ? <h2>{title}</h2> : null}
      {children}
    </section>
  );
}

export function Button({ children, variant = 'primary', type = 'submit', name, value }: { children: ReactNode; variant?: 'primary' | 'ghost' | 'danger'; type?: 'submit' | 'button'; name?: string; value?: string }) {
  return <button type={type} name={name} value={value} className={`mc-btn mc-btn-${variant}`}>{children}</button>;
}

export function Field({ label, name, type = 'text', required, placeholder, defaultValue, hint, autoComplete, inputMode, pattern }: {
  label: string; name: string; type?: string; required?: boolean; placeholder?: string; defaultValue?: string; hint?: string; autoComplete?: string; inputMode?: 'numeric' | 'decimal' | 'tel' | 'email' | 'text'; pattern?: string;
}) {
  return (
    <label className="mc-field">
      <span>{label}</span>
      <input name={name} type={type} required={required} placeholder={placeholder} defaultValue={defaultValue} autoComplete={autoComplete} inputMode={inputMode} pattern={pattern} />
      {hint ? <small className="mc-muted">{hint}</small> : null}
    </label>
  );
}

export function Select({ label, name, options, required, defaultValue }: { label: string; name: string; options: { value: string; label: string }[]; required?: boolean; defaultValue?: string }) {
  return (
    <label className="mc-field">
      <span>{label}</span>
      <select name={name} required={required} defaultValue={defaultValue}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

export function Table<T>({ rows, columns, empty }: { rows: T[]; columns: { header: string; cell: (r: T) => ReactNode }[]; empty: string }) {
  if (!rows.length) return <p className="mc-empty">{empty}</p>;
  return (
    <div className="mc-table-wrap">
      <table className="mc-table">
        <thead><tr>{columns.map((c) => <th key={c.header} scope="col">{c.header}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{columns.map((c) => <td key={c.header}>{c.cell(r)}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'success' | 'warning' | 'danger' }) {
  return <span className={`mc-badge mc-badge-${tone}`}>{children}</span>;
}

export function Alert({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'error' | 'success' }) {
  return <div role={tone === 'error' ? 'alert' : 'status'} className={`mc-alert mc-alert-${tone}`}>{children}</div>;
}

export function TextArea({ label, name, rows = 3, placeholder, defaultValue, maxLength }: { label: string; name: string; rows?: number; placeholder?: string; defaultValue?: string; maxLength?: number }) {
  return (
    <label className="mc-field mc-field-wide">
      <span>{label}</span>
      <textarea name={name} rows={rows} placeholder={placeholder} defaultValue={defaultValue} maxLength={maxLength} />
    </label>
  );
}

/** A group of checkboxes sharing one name (FormData.getAll(name)). */
export function CheckboxGroup({ legend, name, options, defaultValues = [] }: { legend: string; name: string; options: { value: string; label: string }[]; defaultValues?: string[] }) {
  return (
    <fieldset className="mc-fieldset mc-field-wide">
      <legend>{legend}</legend>
      <div className="mc-checks">
        {options.map((o) => (
          <label key={o.value} className="mc-check">
            <input type="checkbox" name={name} value={o.value} defaultChecked={defaultValues.includes(o.value)} />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function Chip({ href, children, active }: { href: string; children: ReactNode; active?: boolean }) {
  return <a href={href} className={`mc-chip${active ? ' active' : ''}`} aria-current={active ? 'true' : undefined}>{children}</a>;
}

/** A KPI tile: a number with a label, an icon, a line underneath; a link when `href` is given. */
export function Kpi({ label, value, sub, icon = 'chart', href, tone }: { label: string; value: ReactNode; sub?: ReactNode; icon?: string; href?: string; tone?: 'success' | 'warning' | 'danger' }) {
  const body = (
    <>
      <span className="mc-kpi-label"><span className="mc-kpi-icon"><Icon name={icon} /></span>{label}</span>
      <span className="mc-kpi-value">{value}</span>
      {sub ? <span className="mc-kpi-sub">{sub}</span> : null}
    </>
  );
  return href ? <a className="mc-kpi" href={href} data-tone={tone}>{body}</a> : <div className="mc-kpi" data-tone={tone}>{body}</div>;
}

/** Horizontal bars (label, share of the largest or of a limit, value). */
export function Bars({ rows, max }: { rows: { label: string; value: number; display?: ReactNode; tone?: 'warning' | 'danger' }[]; max?: number }) {
  const top = max ?? Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length) return <p className="mc-empty">Nothing yet.</p>;
  return (
    <div className="mc-bars">
      {rows.map((r) => (
        <div key={r.label} className="mc-bar">
          <span>{r.label}</span>
          <div className="mc-bar-track" aria-hidden><div className="mc-bar-fill" data-tone={r.tone} style={{ width: `${Math.min(100, (r.value / top) * 100)}%` }} /></div>
          <strong>{r.display ?? r.value}</strong>
        </div>
      ))}
    </div>
  );
}

/** Vertical columns (e.g. the next 7 days). */
export function Columns({ rows }: { rows: { label: string; value: number }[] }) {
  const top = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="mc-columns" role="img" aria-label={rows.map((r) => `${r.label}: ${r.value}`).join(', ')}>
      {rows.map((r) => (
        <div key={r.label} className="mc-column" title={`${r.label}: ${r.value}`}>
          <div className="mc-column-bar" style={{ height: `${Math.max(3, (r.value / top) * 100)}%` }} />
          <small>{r.label}</small>
        </div>
      ))}
    </div>
  );
}
