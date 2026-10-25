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
