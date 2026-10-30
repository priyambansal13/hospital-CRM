import { getSession } from '@mc/auth';
import { api } from '@mc/bff';
import { hasFeature, ZoneFrame, zoneCapabilities } from '@mc/features';
import { Upsell } from '@mc/features/plan';
import { Alert, Badge, Button, Card, Field, PageHeader, Table } from '@mc/ui';
import { Flash } from '@/lib/flash';
import { ZONES } from '@/lib/zones';
import { addDomain, removeDomain, saveBranding, saveSetting, verifyDomain } from './actions';
import { savePayoutAccount, sendPayoutCode } from './payout-actions';

export const dynamic = 'force-dynamic';

interface Setting { key: string; moduleName: string; name: string; type: 'int' | 'enum' | 'bool'; default: unknown; min: number | null; max: number | null; allowed: string[] | null; planBounded: boolean; value: unknown; effective: unknown; adjusted: boolean; updatedBy: string | null }
interface Domain { host: string; primary: boolean; status: 'PENDING' | 'ACTIVE'; custom: boolean; dns: { type: string; name: string; value: string; cname: { name: string; target: string } } | null }
interface Account { connected: boolean; holdUntil: string | null; account: { businessName: string; bankLast4: string | null; ifsc: string | null; platformFeePercent: number; connectedAt: string } | null; transfers: { count: number; amount: number; platformFee: number; onHold?: number } }
interface Change { at: string; by: string; change: string; bankLast4: string | null; ifsc: string | null; prevBankLast4: string | null; holdUntil: string | null }
interface Branding { name: string; branding: { primaryColor?: string; accentColor?: string; logoUrl?: string | null } }
const inr = (n: number) => `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(n)}`;
const when = (d: string) => new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });

/** The hospital's own configuration: branding, settings within its plan, custom domain, payout account. */
export default async function Settings({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string; code?: string }> }) {
  const caps = await zoneCapabilities('admin', '/admin/settings');
  const sp = await searchParams;
  const { accessToken: token } = (await getSession())!;
  const [brand, settings, domains, account, changes] = await Promise.all([
    api<Branding>('/api/tenant/v1/public/branding', { token }),
    api<Setting[]>('/api/entitlement/v1/settings', { token }),
    api<Domain[]>('/api/tenant/v1/domains', { token }),
    caps.modules.includes('billing') ? api<Account>('/api/billing/v1/payment-account', { token }).catch(() => null) : Promise.resolve(null),
    caps.modules.includes('billing') ? api<Change[]>('/api/billing/v1/payment-account/history', { token }).catch(() => [] as Change[]) : Promise.resolve([] as Change[]),
  ]);
  const customDomains = hasFeature(caps, 'core.custom_domain');
  return (
    <ZoneFrame zone="admin" path="/admin/settings" zones={ZONES}>
      <PageHeader title="Settings" subtitle="How your hospital looks and works. Some ranges come from your plan." />
      <Flash ok={sp.ok} error={sp.error} />
      <Card title="Branding">
        <form action={saveBranding} className="mc-form" aria-label="Branding">
          <Field label="Name patients see" name="name" required defaultValue={brand.name} />
          <label className="mc-field"><span>Main colour</span><input type="color" name="primaryColor" defaultValue={brand.branding.primaryColor ?? '#0f766e'} /></label>
          <label className="mc-field"><span>Accent colour</span><input type="color" name="accentColor" defaultValue={brand.branding.accentColor ?? '#f59e0b'} /></label>
          <Field label="Logo URL" name="logoUrl" type="url" defaultValue={brand.branding.logoUrl ?? ''} />
          <Button>Save branding</Button>
        </form>
        <p className="mc-meta" style={{ marginBottom: 0 }}>Message wording (SMS / e-mail): <a href="/admin/messages?tab=templates">Messages → Templates</a>.</p>
      </Card>

      <Card title="Rules">
        <Table rows={settings} empty="No settings for your modules." columns={[
          { header: 'Setting', cell: (s) => <><strong>{s.name}</strong><div className="mc-meta">{s.moduleName}{s.planBounded ? ' · range set by your plan' : ''}</div></> },
          { header: 'Value', cell: (s) => (
            <form action={saveSetting} className="mc-inline" aria-label={`Setting ${s.name}`}>
              <input type="hidden" name="key" value={s.key} /><input type="hidden" name="type" value={s.type} />
              {s.type === 'int' ? <input name="value" type="number" min={s.min ?? undefined} max={s.max ?? undefined} defaultValue={String(s.effective)} aria-label={s.name} className="mc-input-sm" style={{ width: 90 }} />
                : s.type === 'bool' ? <select name="value" defaultValue={String(s.effective)} aria-label={s.name}><option value="true">yes</option><option value="false">no</option></select>
                : <select name="value" defaultValue={String(s.effective)} aria-label={s.name}>{(s.allowed ?? []).map((v) => <option key={v} value={v}>{v}</option>)}</select>}
              <button className="mc-btn mc-btn-ghost">Save</button>
            </form>
          ) },
          { header: 'Allowed', cell: (s) => <span className="mc-meta">{s.type === 'int' ? `${s.min ?? '…'}–${s.max ?? '…'}` : s.allowed?.join(', ') ?? 'yes / no'}{s.adjusted ? <> <Badge tone="warning">adjusted to your plan</Badge></> : null}</span> },
        ]} />
      </Card>

      <Card title="Web addresses">
        <Table rows={domains} empty="" columns={[
          { header: 'Address', cell: (d) => <><strong>{d.host}</strong>{d.primary ? <span className="mc-meta"> (MediCare address)</span> : null}</> },
          { header: 'Status', cell: (d) => <Badge tone={d.status === 'ACTIVE' ? 'success' : 'warning'}>{d.status === 'ACTIVE' ? 'working' : 'waiting for DNS'}</Badge> },
          { header: '', cell: (d) => (d.primary ? null : (
            <div>
              {d.dns ? <p className="mc-meta" style={{ marginTop: 0 }}>Add at your DNS provider: <code>{d.dns.type} {d.dns.name} = {d.dns.value}</code> and <code>CNAME {d.dns.cname.name} → {d.dns.cname.target}</code></p> : null}
              <div className="mc-inline">
                {d.status === 'PENDING' ? <form action={verifyDomain}><input type="hidden" name="host" value={d.host} /><button className="mc-btn mc-btn-ghost">Verify</button></form> : null}
                <form action={removeDomain}><input type="hidden" name="host" value={d.host} /><button className="mc-btn mc-btn-ghost">Remove</button></form>
              </div>
            </div>
          )) },
        ]} />
        {customDomains ? (
          <form action={addDomain} className="mc-inline" aria-label="Add a domain" style={{ marginTop: 12 }}>
            <input name="host" required placeholder="care.myhospital.in" aria-label="Domain" className="mc-input-sm" style={{ width: 240 }} />
            <button className="mc-btn mc-btn-ghost">Add your own domain</button>
          </form>
        ) : <div style={{ marginTop: 12 }}><Upsell feature="core.custom_domain" compact /></div>}
      </Card>

      {account ? (
        <Card title="Patients' online payments">
          {account.connected && account.account ? (
            <p style={{ marginTop: 0 }}><Badge tone="success">connected</Badge> {account.account.businessName} · bank ••{account.account.bankLast4} ({account.account.ifsc}) · MediCare fee {account.account.platformFeePercent}%
              <span className="mc-meta"> · paid out so far: {inr(account.transfers.amount)} ({account.transfers.count} payments, fees {inr(account.transfers.platformFee)})</span></p>
          ) : <p style={{ marginTop: 0 }}>Not connected: patients pay at the hospital.</p>}
          {account.holdUntil ? <Alert>The bank account was changed recently: payouts ({inr(account.transfers.onHold ?? 0)} so far) are held until {when(account.holdUntil)}, so an unexpected change can be undone first.</Alert> : null}
          <details open={sp.code === 'sent'}>
            <summary>{account.connected ? 'Change bank account' : 'Connect a bank account'}</summary>
            {account.connected ? (
              // replacing the account needs a code e-mailed to you (review B-5)
              <form action={sendPayoutCode} style={{ marginTop: 12 }}>
                <p className="mc-meta" style={{ marginTop: 0 }}>To change it, we first e-mail you a confirmation code. Every owner is told about the change, and payouts to the new account wait {48} hours.</p>
                <Button variant="ghost">{sp.code === 'sent' ? 'Send another code' : 'E-mail me a code'}</Button>
              </form>
            ) : null}
            <form action={savePayoutAccount} className="mc-form" aria-label="Payments" style={{ marginTop: 12 }}>
              {account.connected ? <Field label="Confirmation code (from the e-mail)" name="stepUpCode" required inputMode="numeric" pattern="\d{6}" /> : null}
              <Field label="Business name (as on PAN)" name="businessName" required defaultValue={account.account?.businessName ?? brand.name} />
              <label className="mc-field"><span>Business type</span><select name="businessType"><option value="proprietorship">Proprietorship</option><option value="partnership">Partnership</option><option value="private_limited">Private limited</option><option value="llp">LLP</option><option value="trust">Trust</option><option value="society">Society</option></select></label>
              <Field label="PAN" name="pan" required placeholder="ABCDE1234F" />
              <Field label="Bank account number" name="accountNumber" required inputMode="numeric" />
              <Field label="IFSC" name="ifsc" required placeholder="HDFC0001234" />
              <Field label="E-mail for payouts" name="email" type="email" required />
              <Button>Save bank account</Button>
            </form>
          </details>
          {changes.length ? (
            <details style={{ marginTop: 12 }}>
              <summary>Changes ({changes.length})</summary>
              <ul className="mc-list">{changes.map((c) => <li key={c.at}>{when(c.at)}: {c.change === 'REPLACED' ? `changed from ••${c.prevBankLast4} to` : 'connected'} ••{c.bankLast4} ({c.ifsc}) by {c.by}</li>)}</ul>
            </details>
          ) : null}
        </Card>
      ) : null}
    </ZoneFrame>
  );
}
