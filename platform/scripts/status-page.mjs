// `mc status publish --out <dir>`: the public status page as static files (index.html, status.json), written every
// minute by the status-publish CronJob into a Cloud Storage bucket (docs/OPERATIONS.md §5). Served from storage, it
// still answers when the cluster or the gateway is down, and then it says so: if tenant-service can't be reached, the
// page says MediCare can't be reached instead of showing stale green.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LABEL = {
  operational: ['Working normally', '#15803d'], maintenance: ['Planned maintenance', '#475569'], degraded: ['Some things are slow or failing', '#b45309'],
  partial_outage: ['Partly down', '#b91c1c'], major_outage: ['Down', '#991b1b'], unreachable: ['Cannot be reached', '#991b1b'],
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ist = (d) => new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });

export function renderStatus(s, checkedAt = new Date()) {
  const badge = (state) => `<span class="b" style="background:${LABEL[state][1]}">${LABEL[state][0]}</span>`;
  const head = s ? (s.overall === 'operational' ? 'All systems working' : LABEL[s.overall][0]) : 'MediCare cannot be reached from here';
  const open = s ? s.incidents.filter((i) => i.status !== 'RESOLVED') : [];
  const past = s ? s.incidents.filter((i) => i.status === 'RESOLVED') : [];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="60">
<title>MediCare status</title><meta name="robots" content="noindex">
<style>
:root{--bg:#f4f6f8;--card:#fff;--text:#0f172a;--muted:#5b6475;--line:#e3e8ee}
@media (prefers-color-scheme:dark){:root{--bg:#0b0f14;--card:#131a22;--text:#e6ebf1;--muted:#9aa6b5;--line:#243040}}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:720px;margin:0 auto;padding:32px 16px}h1{font-size:1.6rem;margin:0 0 4px}.m{color:var(--muted);font-size:14px}
section{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin-top:16px}
ul{list-style:none;margin:0;padding:0}li.c{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-top:1px solid var(--line)}li.c:first-child{border-top:0}
.b{color:#fff;border-radius:999px;padding:2px 10px;font-size:13px;font-weight:600;white-space:nowrap}h2{font-size:1.05rem;margin:0 0 8px}
</style></head><body><main>
<h1>MediCare status</h1><p class="m">Checked ${esc(ist(checkedAt))} IST · refreshes every minute</p>
<section><h2>${esc(head)}</h2>${s ? '' : '<p class="m">Our checks could not reach MediCare. If you cannot use MediCare either, we are working on it; this page updates every minute.</p>'}</section>
${open.map((i) => `<section><h2>${esc(i.title)}</h2><p class="m">${esc(i.impact === 'MAINTENANCE' ? 'Planned maintenance' : i.impact.toLowerCase())} · ${esc(i.status.toLowerCase())} · since ${esc(ist(i.startsAt))}${i.endsAt ? ` until ${esc(ist(i.endsAt))}` : ''}</p><ul>${i.updates.map((u) => `<li><strong>${esc(u.status.toLowerCase())}</strong> (${esc(ist(u.at))}): ${esc(u.message)}</li>`).join('')}</ul></section>`).join('\n')}
${s ? `<section><h2>Components</h2><ul>${s.components.map((c) => `<li class="c"><span>${esc(c.name)}</span>${badge(c.state)}</li>`).join('')}</ul></section>` : ''}
${past.length ? `<section><h2>Past 14 days</h2><ul>${past.map((i) => `<li><strong>${esc(i.title)}</strong> <span class="m">${esc(ist(i.startsAt))} – ${esc(i.resolvedAt ? ist(i.resolvedAt) : '')}</span></li>`).join('')}</ul></section>` : ''}
</main></body></html>
`;
}

export async function publishStatus(out, source) {
  const s = await fetch(`${source}/v1/status`, { signal: AbortSignal.timeout(10_000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'status.json'), JSON.stringify(s ?? { updatedAt: new Date().toISOString(), overall: 'unreachable', components: [], incidents: [] }, null, 1));
  writeFileSync(join(out, 'index.html'), renderStatus(s));
  return s ? s.overall : 'unreachable';
}
