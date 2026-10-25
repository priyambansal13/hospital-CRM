import 'server-only';
import { api } from '@mc/bff';
import type { Capabilities } from '@mc/features';

export interface Invoice {
  id: string; invoiceNo: string; status: string; paymentMode: string; description: string;
  source: { type: string; id: string }; patient: { name: string; mrn: string }; branch: { name: string };
  total: number; amountPaid: number; amountRefunded: number; payBy: string | null; issuedAt: string; paidAt: string | null; voidReason: string | null;
}
export interface InvoiceDetail extends Invoice {
  payments: { id: string; channel: string; amount: number; method: string | null; status: string; lastError: string | null; capturedAt: string | null }[];
  refunds: { id: string; amount: number; reason: string; status: string; processedAt: string | null }[];
  checkout: { gateway: 'RAZORPAY' | 'SIMULATED'; keyId: string; orderId: string; amount: number; currency: string } | null;
}

export const myInvoices = (token: string) => api<Invoice[]>('/api/billing/v1/me/invoices', { token });
export const invoiceDetail = (token: string, id: string) => api<InvoiceDetail>(`/api/billing/v1/invoices/${encodeURIComponent(id)}`, { token });

/** Online payment is offered when the hospital has the billing module and the plan's online payments feature. */
export const canPayOnline = (caps: Capabilities) => caps.modules.includes('billing') && caps.features['billing.online_payments']?.enabled !== false;

export const inr = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
export const INVOICE_STATUS: Record<string, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  ISSUED: { label: 'To pay', tone: 'warning' }, PAID: { label: 'Paid', tone: 'success' },
  PARTIALLY_REFUNDED: { label: 'Partly refunded', tone: 'neutral' }, REFUNDED: { label: 'Refunded', tone: 'neutral' }, VOID: { label: 'Cancelled', tone: 'neutral' },
};
