/**
 * The invoice calculator (docs/PRODUCT-MODULES-AND-PLANS.md §5): base price + seats + branches + tiered volume +
 * add-ons, prorated for part periods; usage beyond the allowance (in arrears, never prorated); coupon; GST.
 * Pure: amounts in rupees, rounded to paise per line.
 */
export type Model = 'FLAT' | 'PER_SEAT' | 'PER_BRANCH' | 'TIERED';
export interface PriceComponent { model: Model; unit?: string; amount?: number; included?: number; tiers?: { upTo: number | null; amount: number }[] }
export interface Line { kind: 'PLAN' | 'SEATS' | 'BRANCHES' | 'ADDON' | 'USAGE' | 'CREDIT'; description: string; quantity: number; unitPrice: number; amount: number }
export interface UsageInput { key: string; name: string; unit: string; used: number; limit: number | null; overage: string | null; unitPrice: number }
export interface ChargeInput {
  plan: { code: string; name: string; listPrice: number; components: PriceComponent[] };
  addons: { code: string; name: string; quantity: number; listPrice: number }[];
  quantities: { doctor: number; branch: number };
  /** share of the period charged: 1 = a whole month; 0.5 = half (proration) */
  fraction: number;
  /** what this period's lines say ("1 Nov–30 Nov"), or a note for a part period */
  periodLabel: string;
  usage?: UsageInput[];
  coupon?: { code: string; percentOff?: number | null; amountOff?: number | null } | null;
  /** negative lines (e.g. unused part of the old plan on an upgrade) */
  credits?: { description: string; amount: number }[];
  gstPercent: number;
}
export interface Invoice { lines: Line[]; subtotal: number; discount: number; discountLabel: string | null; taxable: number; gst: number; gstPercent: number; total: number }

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Doctors charged per tier: each doctor at the rate of the tier it falls in (1–25 free, 26–100 at ₹399, …). */
export function tierBreakdown(count: number, tiers: { upTo: number | null; amount: number }[]) {
  const out: { from: number; to: number; quantity: number; amount: number }[] = [];
  let from = 1;
  for (const t of tiers) {
    const to = t.upTo ?? Number.POSITIVE_INFINITY;
    const q = Math.max(0, Math.min(count, to) - from + 1);
    if (q > 0) out.push({ from, to: Math.min(count, to), quantity: q, amount: t.amount });
    if (count <= to) break;
    from = to + 1;
  }
  return out;
}

/** The recurring charges for one month (no usage, coupon or tax), before proration. */
export function recurringLines(i: Pick<ChargeInput, 'plan' | 'addons' | 'quantities'>): Line[] {
  const lines: Line[] = [];
  const flat = i.plan.components.find((c) => c.model === 'FLAT');
  lines.push({ kind: 'PLAN', description: i.plan.name, quantity: 1, unitPrice: flat?.amount ?? i.plan.listPrice, amount: flat?.amount ?? i.plan.listPrice });
  for (const c of i.plan.components) {
    if (c.model === 'PER_SEAT' || c.model === 'PER_BRANCH') {
      const what = c.model === 'PER_SEAT' ? 'doctor' : 'branch';
      const n = Math.max(0, i.quantities[what] - (c.included ?? 0));
      if (n > 0) lines.push({ kind: c.model === 'PER_SEAT' ? 'SEATS' : 'BRANCHES', description: `${what === 'doctor' ? 'Doctors' : 'Branches'} beyond ${c.included ?? 0} included`, quantity: n, unitPrice: c.amount ?? 0, amount: n * (c.amount ?? 0) });
    }
    if (c.model === 'TIERED') {
      for (const t of tierBreakdown(i.quantities.doctor, c.tiers ?? [])) {
        if (t.amount > 0) lines.push({ kind: 'SEATS', description: `Doctors ${t.from}–${t.to}`, quantity: t.quantity, unitPrice: t.amount, amount: t.quantity * t.amount });
      }
    }
  }
  for (const a of i.addons) lines.push({ kind: 'ADDON', description: a.name, quantity: a.quantity, unitPrice: a.listPrice, amount: a.quantity * a.listPrice });
  return lines;
}

export const monthlyTotal = (i: Pick<ChargeInput, 'plan' | 'addons' | 'quantities'>) => r2(recurringLines(i).reduce((s, l) => s + l.amount, 0));

/** Usage beyond the allowance, billed when the plan says ALLOW_BILL. */
export function usageLines(usage: UsageInput[] = []): Line[] {
  const out: Line[] = [];
  for (const u of usage) {
    if (u.overage !== 'ALLOW_BILL' || u.limit == null || u.used <= u.limit || u.unitPrice <= 0) continue;
    const over = u.used - u.limit;
    out.push({ kind: 'USAGE', description: `${u.name} beyond ${u.limit.toLocaleString('en-IN')} included (${u.used.toLocaleString('en-IN')} used)`, quantity: over, unitPrice: u.unitPrice, amount: r2(over * u.unitPrice) });
  }
  return out;
}

export function calculate(i: ChargeInput): Invoice {
  const f = Math.max(0, Math.min(1, i.fraction));
  const recurring = recurringLines(i).map((l) => (f === 1 ? l : { ...l, description: `${l.description} (${i.periodLabel})`, amount: r2(l.amount * f) }));
  const lines: Line[] = [
    ...recurring.map((l) => ({ ...l, amount: r2(l.amount) })),
    ...usageLines(i.usage),
    ...(i.credits ?? []).map((c) => ({ kind: 'CREDIT' as const, description: c.description, quantity: 1, unitPrice: -Math.abs(c.amount), amount: -r2(Math.abs(c.amount)) })),
  ];
  const subtotal = r2(lines.reduce((s, l) => s + l.amount, 0));
  const positive = Math.max(0, subtotal);
  let discount = 0;
  let discountLabel: string | null = null;
  if (i.coupon && positive > 0) {
    if (i.coupon.percentOff) { discount = r2(positive * i.coupon.percentOff / 100); discountLabel = `${i.coupon.code}: ${i.coupon.percentOff}% off`; }
    else if (i.coupon.amountOff) { discount = r2(Math.min(positive, i.coupon.amountOff)); discountLabel = `${i.coupon.code}: ₹${i.coupon.amountOff} off`; }
  }
  // a credit larger than the charges is not paid out: the invoice is zero (the rest is not carried, kept simple)
  const taxable = r2(Math.max(0, subtotal - discount));
  const gst = r2(taxable * i.gstPercent / 100);
  return { lines, subtotal, discount, discountLabel, taxable, gst, gstPercent: i.gstPercent, total: r2(taxable + gst) };
}

/** Days-based share of a period still to come (proration), e.g. 15 of 30 days left → 0.5. */
export function remainingFraction(now: Date, start: Date, end: Date) {
  const total = end.getTime() - start.getTime();
  if (total <= 0) return 0;
  return Math.max(0, Math.min(1, (end.getTime() - now.getTime()) / total));
}
