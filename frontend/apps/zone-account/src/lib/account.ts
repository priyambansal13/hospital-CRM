import { getSession } from '@mc/auth';
import { api } from '@mc/bff';

/** Types of subscription-service /v1/account (the hospital's own MediCare subscription). */
export type Status = 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'GRACE' | 'SUSPENDED' | 'CANCELLED' | 'EXPIRED';
export interface Line { kind: string; description: string; quantity: number; unitPrice: number; amount: number }
export interface Estimate { quantities: { doctor: number; branch: number }; lines: Line[]; subtotal: number; discount: number; gst: number; gstPercent: number; total: number }
export interface Summary {
  status: Status; now: string; trialEndsAt: string | null; periodStart: string | null; periodEnd: string | null; cancelAtPeriodEnd: boolean;
  paymentMethod: { kind: 'CARD' | 'OFFLINE'; brand: string | null; last4: string | null } | null;
  /** the gateway takes cards (false: bank transfer only) */
  cardPayments?: boolean;
  coupon: { code: string; invoicesLeft: number | null } | null;
  pendingChange: { plan: string; addons: { code: string; quantity: number }[]; requestedBy: string } | null;
  pastDueSince: string | null; nextRetryAt: string | null; graceEndsAt: string | null; suspendedAt: string | null;
  unpaid: { invoices: number; total: number };
  plan: { code: string; name: string; version: number }; addons: { code: string; name: string; quantity: number }[];
  estimate: Estimate | null; clockOffsetDays: number;
}
export interface PlanChoice { code: string; name: string; edition: string; tier: string; listPrice: number; monthly: number; current: boolean; modules: string[]; addons: string[] }
export interface InvoiceRow { id: string; number: string; kind: string; periodStart: string; periodEnd: string; status: 'OPEN' | 'PAID' | 'FAILED' | 'VOID'; total: number; attempts: number; lastError: string | null; issuedAt: string; paidAt: string | null }
export interface InvoiceDetail extends InvoiceRow { lines: Line[]; subtotal: number; discount: number; discountLabel: string | null; gst: number; gstPercent: number; plan: { code: string; name: string; version: number } }
export interface Meter { key: string; name: string; unit: string; month: string; used: number; limit: number | null; overage: 'BLOCK' | 'SOFT_WARN' | 'ALLOW_BILL' | null; percent: number | null; history: { month: string; used: number; billed: boolean }[] }

export async function get<T>(path: string): Promise<T> {
  return api<T>(`/api/subscription/v1/account${path}`, { token: (await getSession())!.accessToken });
}

export const inr = (n: number) => `₹${new Intl.NumberFormat('en-IN', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }).format(n)}`;
export const day = (d: string | null) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—');
/** a period end is exclusive (1 Dec 00:00): show the last day of the period */
export const lastDay = (d: string | null) => (d ? day(new Date(new Date(d).getTime() - 1).toISOString()) : '—');
export const STATUS: Record<Status, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  TRIALING: { label: 'free trial', tone: 'neutral' }, ACTIVE: { label: 'active', tone: 'success' }, PAST_DUE: { label: 'payment failed', tone: 'warning' },
  GRACE: { label: 'overdue (grace period)', tone: 'danger' }, SUSPENDED: { label: 'suspended: read only', tone: 'danger' }, CANCELLED: { label: 'cancelled', tone: 'neutral' }, EXPIRED: { label: 'trial ended', tone: 'neutral' },
};
export const INVOICE: Record<InvoiceRow['status'], { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  PAID: { label: 'paid', tone: 'success' }, OPEN: { label: 'due', tone: 'warning' }, FAILED: { label: 'payment failed', tone: 'danger' }, VOID: { label: 'void', tone: 'neutral' },
};
