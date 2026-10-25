/**
 * Cancellation refund policy (docs/LLD.md §5.5), a strategy so hospitals can get their own in Phase 20.
 * Only applies to money actually paid; the hospital cancelling (staff, doctor leave) always refunds in full.
 */
export interface RefundPolicy {
  percent(input: { paid: boolean; cancelledBy: 'patient' | 'hospital'; startsAt: Date; now?: Date }): number | null;
}

export const TimeBasedRefundPolicy = (opts = {
  fullRefundHours: Number(process.env.REFUND_FULL_HOURS ?? 24),
  partialRefundHours: Number(process.env.REFUND_PARTIAL_HOURS ?? 2),
  partialPercent: Number(process.env.REFUND_PARTIAL_PERCENT ?? 50),
}): RefundPolicy & { opts: typeof opts } => ({
  opts,
  percent({ paid, cancelledBy, startsAt, now = new Date() }) {
    if (!paid) return null;
    if (cancelledBy === 'hospital') return 100;
    const hours = (startsAt.getTime() - now.getTime()) / 3_600_000;
    if (hours >= opts.fullRefundHours) return 100;
    if (hours >= opts.partialRefundHours) return opts.partialPercent;
    return 0;
  },
});

export const REFUND_POLICY = TimeBasedRefundPolicy();
