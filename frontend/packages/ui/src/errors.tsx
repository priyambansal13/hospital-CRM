'use client';
/**
 * Branded error and not-found pages for every zone (docs/ROLE-FLOWS-AND-GAPS.md F-1): never the bare Next.js screen,
 * always a way back. Server errors carry only a reference (digest) in production; the details stay in the logs.
 */
export function ErrorView({ error, reset, home }: { error: Error & { digest?: string }; reset?: () => void; home: string }) {
  const denied = /\b403\b|not allowed|missing permission|PERMISSION_DENIED|MODULE_NOT_IN_PLAN/i.test(error.message ?? '');
  return (
    <main className="mc-main" style={{ maxWidth: 640 }}>
      <div className="mc-card" role="alert">
        <h1>{denied ? 'You don’t have access to this page' : 'Something went wrong'}</h1>
        <p className="mc-muted">
          {denied
            ? 'Your role or your hospital’s plan doesn’t include it. Ask your hospital admin if you need it.'
            : 'We couldn’t load this page. Please try again in a moment. If it keeps happening, tell your hospital’s support with the reference below.'}
        </p>
        <p style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 16 }}>
          {reset && !denied ? <button type="button" className="mc-btn mc-btn-primary" onClick={() => reset()}>Try again</button> : null}
          <a className="mc-btn mc-btn-ghost" href={home}>Go to the home page</a>
        </p>
        {error.digest ? <p className="mc-meta">Reference: {error.digest}</p> : null}
      </div>
    </main>
  );
}

export function NotFoundView({ home }: { home: string }) {
  return (
    <main className="mc-main" style={{ maxWidth: 640 }}>
      <div className="mc-card">
        <h1>Page not found</h1>
        <p className="mc-muted">This page doesn’t exist, or the link is out of date.</p>
        <p style={{ marginTop: 16 }}><a className="mc-btn mc-btn-primary" href={home}>Go to the home page</a></p>
      </div>
    </main>
  );
}
