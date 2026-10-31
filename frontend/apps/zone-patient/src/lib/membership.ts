import { api } from '@mc/bff';

export interface Benefits { bookingWindowDays: number; priorityAccess: boolean; freeVideoConsultsPerMonth: number; labDiscountPct: number; freeHomeCollection: boolean; familyMembers: number }
export interface Tier { id: string; code: string; name: string; description: string | null; price: number; period: 'MONTHLY' | 'YEARLY'; benefits: Benefits; active: boolean; sort: number; version: number }
export interface Membership { id: string; status: string; plan: { code: string; name: string; price: number; period: string; benefits: Benefits }; patientName: string; startsAt: string | null; endsAt: string | null; invoiceId: string | null; createdAt: string }

export const myMembership = (token: string) => api<{ membership: Membership | null; pending: Membership | null; plans: Tier[] }>('/api/billing/v1/me/membership', { token });

/** What a tier gives, as short lines a patient understands. */
export const perks = (b: Benefits) => [
  `Book up to ${b.bookingWindowDays} days ahead`,
  b.priorityAccess ? 'Members-only appointment times' : null,
  b.freeVideoConsultsPerMonth ? `${b.freeVideoConsultsPerMonth} free video consultation${b.freeVideoConsultsPerMonth === 1 ? '' : 's'} a month` : null,
  b.labDiscountPct ? `${b.labDiscountPct}% off lab tests` : null,
  b.freeHomeCollection ? 'Free home sample collection' : null,
  `Covers ${b.familyMembers === 1 ? 'you' : `you and ${b.familyMembers - 1} family member${b.familyMembers === 2 ? '' : 's'}`}`,
].filter(Boolean) as string[];
