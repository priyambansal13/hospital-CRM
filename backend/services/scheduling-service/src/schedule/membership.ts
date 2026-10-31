import { Injectable } from '@nestjs/common';
import type { Capabilities, MembershipBenefits } from '@mc/contracts';
import { EntitlementsClient } from '@mc/entitlements-sdk';
import { createHash } from 'node:crypto';

/** What memberships change for one patient's booking (Phase 26). `active` false: the hospital has no memberships. */
export interface MemberRules { active: boolean; windowDays: number | null; priorityPct: number; member: (MembershipBenefits & { planName: string }) | null }
export const NO_RULES: MemberRules = { active: false, windowDays: null, priorityPct: 0, member: null };

/**
 * Is this slot held for members? A fixed share of each doctor's times (the hospital's `memberships.priority_percent`),
 * picked by a stable hash of the slot id, until 24 hours before it starts (then anyone may book it).
 */
export function membersOnly(slotId: string, startsAt: Date | string, pct: number) {
  if (pct <= 0 || new Date(startsAt).getTime() - Date.now() < 24 * 3_600_000) return false;
  return createHash('md5').update(slotId).digest().readUInt16BE(0) % 100 < pct;
}

/** Asks billing-service what an account's membership gives (cached a minute: benefits change rarely). */
@Injectable()
export class MembershipRules {
  private readonly cache = new Map<string, { at: number; v: { member: boolean; planName?: string; benefits?: MembershipBenefits } }>();
  constructor(private readonly entitlements: EntitlementsClient) {}

  private async benefits(tenantId: string, personId: string) {
    const key = `${tenantId}:${personId}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.v;
    const res = await fetch(`${process.env.SVC_URL_BILLING ?? 'http://localhost:4409'}/internal/tenants/${tenantId}/members/${personId}`, { headers: { 'x-internal-token': process.env.INTERNAL_API_TOKEN ?? '' }, signal: AbortSignal.timeout(3000) }).catch(() => null);
    // billing unreachable: treated as no membership (members lose a perk for a minute; nobody gets one they did not buy)
    const v = res?.ok ? ((await res.json()) as { member: boolean; planName?: string; benefits?: MembershipBenefits }) : { member: false };
    this.cache.set(key, { at: Date.now(), v });
    if (this.cache.size > 5000) this.cache.delete(this.cache.keys().next().value!);
    return v;
  }

  forget(tenantId: string, personId: string) { this.cache.delete(`${tenantId}:${personId}`); }

  async moduleOn(tenantId: string) {
    return (await this.entitlements.moduleState(tenantId, 'memberships').catch(() => 'OFF')) === 'ACTIVE';
  }

  async priorityPct(tenantId: string) {
    return this.entitlements.setting<number>(tenantId, 'memberships.priority_percent', 20);
  }

  async rulesFor(tenantId: string, caps: Capabilities, personId: string): Promise<MemberRules> {
    if (!caps.modules.includes('memberships')) return NO_RULES;
    const [b, freeWindow, pct] = await Promise.all([this.benefits(tenantId, personId), this.entitlements.setting<number>(tenantId, 'memberships.free_window_days', 14), this.priorityPct(tenantId)]);
    const member = b.member && b.benefits ? { ...b.benefits, planName: b.planName ?? 'member' } : null;
    return { active: true, windowDays: member ? member.bookingWindowDays : freeWindow, priorityPct: pct, member };
  }
}
