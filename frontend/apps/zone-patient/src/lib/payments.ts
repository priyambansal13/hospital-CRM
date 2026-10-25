import { api } from '@mc/bff';

/** Does this hospital take online payments (a payout account is connected)? If not, patients pay at the hospital. */
export const onlinePaymentsReady = () => api<{ online: boolean }>('/api/billing/v1/public/payment-status').then((r) => r.online, () => false);
