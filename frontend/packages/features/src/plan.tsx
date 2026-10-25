/**
 * Plan-aware UI (docs/PRODUCT-MODULES-AND-PLANS.md §8, §10): read-only notices for modules no longer in the plan, and
 * <Upsell> showing the cheapest add-on or plan that unlocks a module or feature (computed by subscription-service).
 */
import 'server-only';
import { getSession } from '@mc/auth';
import { api } from '@mc/bff';
import { Alert } from '@mc/ui';
import type { Capabilities } from './index.js';

export const isReadOnly = (caps: Capabilities, module: string) => (caps.readOnlyModules ?? []).includes(module);
export const isActivating = (caps: Capabilities, module: string) => (caps.activatingModules ?? []).includes(module);

const MODULE_NAMES: Record<string, string> = { diagnostics: 'Diagnostics and lab', home_collection: 'Home sample collection', appointments: 'Appointments', front_desk: 'Front desk', emr: 'Clinical records', billing: 'Billing', directory: 'Doctor directory' };

/** Shown at the top of a module's pages when the hospital's plan no longer includes it: data stays, nothing new. */
export function ReadOnlyNotice({ caps, module }: { caps: Capabilities; module: string }) {
  if (isActivating(caps, module)) return <Alert tone="info">{MODULE_NAMES[module] ?? module} is being switched on for your hospital. This takes a few seconds.</Alert>;
  if (!isReadOnly(caps, module)) return null;
  return (
    <div role="status" aria-label="Read-only module">
      <Alert tone="info"><strong>Read only.</strong> {MODULE_NAMES[module] ?? module} is no longer in your hospital&apos;s plan. Existing records can be viewed; nothing new can be added.</Alert>
    </div>
  );
}

interface UpsellOption { kind: 'ADDON' | 'PLAN'; code: string; name: string; price: number; monthlyTotal: number }
interface UpsellAnswer { target: { module: string; moduleName: string; feature: string | null; featureName: string | null }; current: { plan: string; name: string; listPrice: number }; options: UpsellOption[] }

const inr = (n: number) => `₹${new Intl.NumberFormat('en-IN').format(n)}`;

/** "Lab is not in your plan: add it for ₹5,999/month, or move to Hospital Professional (₹24,999/month)". */
export async function Upsell({ module, feature, compact = false }: { module?: string; feature?: string; compact?: boolean }) {
  const session = await getSession();
  if (!session) return null;
  const q = module ? `module=${encodeURIComponent(module)}` : `feature=${encodeURIComponent(feature ?? '')}`;
  const u = await api<UpsellAnswer>(`/api/subscription/v1/upsell?${q}`, { token: session.accessToken }).catch(() => null);
  if (!u) return null;
  const what = u.target.featureName ? `More ${u.target.featureName.toLowerCase()}` : u.target.moduleName;
  return (
    <aside className="mc-upsell" aria-label={`Upgrade for ${u.target.featureName ?? u.target.moduleName}`}>
      <p style={{ margin: 0 }}><strong>{what}</strong> {u.target.feature ? `needs a bigger plan than ${u.current.name}.` : `is not in your plan (${u.current.name}).`}</p>
      {u.options.length ? (
        <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          {(compact ? u.options.slice(0, 1) : u.options).map((o) => (
            <li key={o.code}>
              {o.kind === 'ADDON'
                ? <>Add <strong>{o.name}</strong> for {inr(o.price)}/month <span className="mc-meta">({inr(o.monthlyTotal)}/month in all)</span></>
                : <>Move to <strong>{o.name}</strong>: {inr(o.price)}/month</>}
            </li>
          ))}
        </ul>
      ) : <p className="mc-meta" style={{ margin: '6px 0 0' }}>Ask MediCare about a custom plan.</p>}
      <p className="mc-meta" style={{ margin: '6px 0 0' }}>Your MediCare account manager can switch your plan (self-serve upgrades come with online billing).</p>
    </aside>
  );
}
