import { Injectable } from '@nestjs/common';
import { DomainError } from '@mc/nest-common';

export interface OnlineCheckout {
  invoiceId: string; invoiceNo: string; amount: number; currency: string;
  gateway: 'RAZORPAY' | 'SIMULATED'; orderId: string; keyId: string;
}

/** billing-service internal API: open an invoice + payment-gateway order for an online booking. */
@Injectable()
export class BillingClient {
  private readonly base = process.env.SVC_URL_BILLING ?? 'http://localhost:4409';

  async openOnlineInvoice(tenantId: string, body: {
    sourceType: 'APPOINTMENT'; sourceId: string; patientId: string; patientName: string; patientMrn: string; accountPersonId: string;
    branchId: string; branchName: string; description: string; amount: number; expiresAt: string;
  }): Promise<OnlineCheckout> {
    const res = await fetch(`${this.base}/internal/tenants/${tenantId}/invoices/online`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-token': process.env.INTERNAL_API_TOKEN ?? '' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    }).catch((e) => { throw new DomainError(502, 'PAYMENTS_UNAVAILABLE', `billing-service unreachable: ${(e as Error).message}`); });
    if (!res.ok) throw new DomainError(502, 'PAYMENTS_UNAVAILABLE', `billing-service ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as OnlineCheckout;
  }
}
