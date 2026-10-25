/**
 * @mc/ui: MediCare design system (minimal M1 set). Theme tokens are CSS variables (theme.css); the hospital's
 * branding overrides --brand / --accent at the frame level.
 */
import type { CSSProperties, ReactNode } from 'react';

export interface FrameNavItem { key: string; label: string; href: string; active?: boolean }

export function AppFrame(props: {
  hospital: { name: string; logoUrl?: string | null; primaryColor?: string; accentColor?: string };
  nav: FrameNavItem[];
  user?: { label: string; signOutHref: string } | null;
  /** shown when nobody is signed in */
  signInHref?: string;
  homeHref?: string;
  children: ReactNode;
}) {
  const style = { '--brand': props.hospital.primaryColor ?? '#0f766e', '--accent': props.hospital.accentColor ?? '#f59e0b' } as CSSProperties;
  return (
    <div className="mc-frame" style={style}>
      <header className="mc-header">
        <a className="mc-brand" href={props.homeHref ?? '/'}>
          {props.hospital.logoUrl ? <img src={props.hospital.logoUrl} alt="" className="mc-logo" /> : <span className="mc-logo-mark" aria-hidden>{props.hospital.name.slice(0, 1)}</span>}
          <span>{props.hospital.name}</span>
        </a>
        <nav className="mc-nav" aria-label="Main">
          {props.nav.map((n) => (
            <a key={n.key} href={n.href} className={n.active ? 'active' : undefined} aria-current={n.active ? 'page' : undefined}>{n.label}</a>
          ))}
        </nav>
        {props.user ? (
          <div className="mc-user">
            <span>{props.user.label}</span>
            <a href={props.user.signOutHref} className="mc-btn mc-btn-ghost">Sign out</a>
          </div>
        ) : props.signInHref ? (
          <div className="mc-user"><a href={props.signInHref} className="mc-btn mc-btn-primary">Sign in</a></div>
        ) : null}
      </header>
      <main className="mc-main">{props.children}</main>
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
  label: string; name: string; type?: string; required?: boolean; placeholder?: string; defaultValue?: string; hint?: string; autoComplete?: string; inputMode?: 'numeric' | 'tel' | 'email' | 'text'; pattern?: string;
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
