import { api } from '@mc/bff';

/** MediCare's own site (pricing, signup) lives on the platform account's host, e.g. medicare.localhost. */
export const PLATFORM_SLUG = process.env.PLATFORM_TENANT_SLUG ?? 'medicare';

export interface PublicPlan {
  code: string; name: string; tier: string; edition: string; listPrice: number; trialDays: number;
  modules: { key: string; name: string }[]; features: Record<string, { enabled: boolean; limit: number | null }>; addons: string[];
}
export const publicPlans = () => api<PublicPlan[]>('/api/subscription/v1/plans');
export const inr = (n: number) => `₹${new Intl.NumberFormat('en-IN').format(n)}`;

export interface SignupStatus {
  id: string; status: 'PENDING' | 'PROVISIONING' | 'READY' | 'FAILED' | 'EXPIRED'; slug: string; hospitalName: string; email: string; plan: string;
  error: string | null; steps: { key: string; label: string; done: boolean }[]; url: string; loginUrl: string | null;
}

/** One plan per name, the cheapest (marketing pages list plans, not every published variant of one). */
export const distinctPlans = (plans: PublicPlan[]) =>
  [...plans].sort((a, b) => a.listPrice - b.listPrice).filter((p, i, all) => all.findIndex((x) => x.name.replace(/\s*[–-]\s*/g, ' ') === p.name.replace(/\s*[–-]\s*/g, ' ')) === i);

/** The live plans that include every one of these modules, cheapest first. */
export const plansWith = (plans: PublicPlan[], modules: string[]) =>
  distinctPlans(plans.filter((p) => modules.every((m) => p.modules.some((x) => x.key === m))));
