import { getSession } from '@mc/auth';
import { api } from '@mc/bff';

/** Types of the platform console API (subscription-service /v1/platform). */
export interface Feature { key: string; name: string; type: 'BOOLEAN' | 'LIMIT' | 'METERED'; unit?: string; default?: boolean }
export interface Setting { key: string; name: string; type: string; default: unknown; min?: number; max?: number; values?: string[]; planBounded: boolean }
export interface RegistryModule {
  key: string; name: string; version: number; alwaysOn: boolean; internal: boolean; dependsOn: string[]; services: string[];
  features: Feature[]; settings: Setting[]; permissions: { code: string; description: string }[]; lifecycle: string[];
}
export interface Addon { code: string; name: string; module: string | null; feature: string | null; extraLimit: number | null; listPrice: number }
export type Status = 'DRAFT' | 'PENDING' | 'PUBLISHED' | 'RETIRED';
export interface VersionSummary { id: string; version: number; status: Status; listPrice: number; createdBy: string; submittedBy: string | null; approvedBy: string | null; publishedAt: string | null; updatedAt: string; hospitals: number }
export interface PlanSummary { code: string; name: string; tier: string; internal: boolean; description: string | null; edition: string; editionName: string; versions: VersionSummary[] }
export interface Definition {
  listPrice: number; trialDays: number; modules: string[];
  features: Record<string, { enabled: boolean; limit: number | null; overage?: 'BLOCK' | 'SOFT_WARN' | 'ALLOW_BILL' | null }>;
  settings: Record<string, { min?: number | null; max?: number | null; allowed?: string[] | null }>;
  addons: string[];
}
export interface VersionDetail {
  id: string; plan: { code: string; name: string; internal: boolean }; version: number; status: Status;
  createdBy: string; updatedBy: string | null; updatedAt: string; submittedBy: string | null; submittedAt: string | null; approvedBy: string | null; publishedAt: string | null;
  reviewNote: string | null; migration: string | null; definition: Definition; problems: string[]; hospitals: number; addons: Addon[];
}
export interface Diff { modulesAdded: string[]; modulesRemoved: string[]; features: { key: string; before: { enabled: boolean; limit: number | null } | null; after: { enabled: boolean; limit: number | null } | null }[] }
export interface Impact {
  plan: string; version: number;
  versusPublished: (Diff & { version: number; price: { before: number; after: number } }) | null;
  hospitals: { tenantId: string; slug: string; fromVersion: number; diff: Diff; price: { before: number; after: number }; droppedAddons: string[]; problems: string[] }[];
  summary: { hospitals: number; losingModules: number; withProblems: number };
}
export interface Hospital {
  id: string; slug: string; status: string;
  plan: { code: string; name: string; version: number; versionStatus: Status; internal: boolean } | null;
  addons: string[]; since: string | null; overrides: number;
}
export interface Effective { modules: { key: string; source: string }[]; features: Record<string, { enabled: boolean; limit: number | null }>; settingBounds: Record<string, { min: number | null; max: number | null }> }
export interface Contract {
  contractId: string;
  plan: { code: string; name: string; tier: string; editionName: string; version: number; listPrice: number; addonCodes: string[] };
  addons: { code: string; name: string; quantity: number }[];
  overrides: { modules?: Record<string, boolean>; features?: Record<string, { enabled?: boolean; limit?: number | null }> };
  since: string; by: string; reason: string; effective: Effective;
}
export interface AuditEntry { id: number; at: string; actor: string; action: string; target: { type: string; id: string; label: string | null }; before: unknown; after: unknown; note: string | null }
export interface HospitalDetail extends Hospital {
  contract: Contract | null;
  history: { id: string; plan: string; version: number; status: string; startsAt: string; endedAt: string | null; by: string; reason: string }[];
  moduleStates: { module_key: string; state: string; source: string; attempts: number; last_error: string | null }[] | null;
  audit: AuditEntry[];
}
export interface Simulation { plan: { code: string; name: string; version: number; status: Status }; price: number; currentPrice: number; effective: Effective; diff: Diff; problems: string[] }

export async function token() {
  return (await getSession())!.accessToken;
}
export const P = '/api/subscription/v1/platform';
export async function get<T>(path: string): Promise<T> {
  return api<T>(`${P}${path}`, { token: await token() });
}

export const inr = (n: number) => `₹${new Intl.NumberFormat('en-IN').format(n)}`;
export const when = (d: string | null) => (d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '—');
export const STATUS: Record<Status, { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' }> = {
  DRAFT: { label: 'draft', tone: 'neutral' },
  PENDING: { label: 'waiting for approval', tone: 'warning' },
  PUBLISHED: { label: 'published', tone: 'success' },
  RETIRED: { label: 'retired', tone: 'neutral' },
};
export const limitText = (f: { enabled: boolean; limit: number | null } | null, unit?: string) => (!f ? 'not in plan' : !f.enabled ? 'off' : f.limit == null ? (unit ? 'unlimited' : 'on') : `${f.limit}${unit ? ` ${unit}` : ''}`);
