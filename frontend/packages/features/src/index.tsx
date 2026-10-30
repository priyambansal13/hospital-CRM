/**
 * @mc/features: role- and plan-based UI (docs/MICROFRONTENDS.md §4). The UI hides what the user can't use; the
 * backend still checks every request.
 */
import 'server-only';
import { getSession, requireSession } from '@mc/auth';
import { api, ApiError, getBranding, origin } from '@mc/bff';
import { Alert, AppFrame } from '@mc/ui';
import { redirect } from 'next/navigation.js';
import { cache, type ReactNode } from 'react';

/** Mirrors @mc/contracts Capabilities (backend). Shared contracts package for the frontend arrives with M2. */
export interface NavItem { key: string; label: string; href: string; zone: string }
export interface Capabilities {
  tenant: { id: string; slug: string };
  actor: { id: string; kind: 'staff' | 'patient' };
  roles: string[];
  modules: string[];
  /** no longer in the plan: data viewable, nothing new (GET only) */
  readOnlyModules: string[];
  activatingModules: string[];
  plan: { code: string; name: string } | null;
  billing?: { status: string; graceEndsAt: string | null; trialEndsAt: string | null };
  permissions: string[];
  /** ":branch" permissions held at some branches only: permission → branch ids (absent = every branch) */
  branchScopes?: Record<string, string[]>;
  /** the branches this person works at; null = every branch */
  branchIds?: string[] | null;
  features: Record<string, { enabled: boolean; limit?: number | null; reason?: string }>;
  nav: NavItem[];
  home: string;
  version: number;
}

/** Once per request; redirects to sign-in when needed. */
export const getCapabilities = cache(async (currentPath: string): Promise<Capabilities> => {
  const session = await requireSession(currentPath);
  try {
    return await api<Capabilities>('/api/entitlement/v1/me/capabilities', { token: session.accessToken });
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) redirect(`${await origin()}/auth/logout?reason=${e.code}`);
    throw e;
  }
});

/** Nav items whose zone is actually deployed (zones.json), so menus never link to a missing zone. */
export function visibleNav(caps: Capabilities, deployedZones: string[]): NavItem[] {
  return caps.nav.filter((n) => deployedZones.includes(n.zone));
}

/** Home path for this user, falling back to "/" when the role's home zone isn't deployed yet. */
export function homeFor(caps: Capabilities, deployedZones: string[], zoneBase: Record<string, string>): string {
  const zone = Object.entries(zoneBase).find(([, base]) => base && (caps.home === base || caps.home.startsWith(base + '/')))?.[0];
  return zone && deployedZones.includes(zone) ? caps.home : '/';
}

/**
 * Use at the top of every signed-in page: capabilities + zone access check BEFORE the page loads its data, so a user
 * without access is redirected instead of the page failing on a 403 from the API.
 */
export async function zoneCapabilities(zone: string, currentPath: string): Promise<Capabilities> {
  const caps = await getCapabilities(currentPath);
  await requireZone(caps, zone);
  return caps;
}

/** A zone is reachable when the user has at least one nav item in it. */
export async function requireZone(caps: Capabilities, zone: string) {
  if (!caps.nav.some((n) => n.zone === zone)) redirect(`${await origin()}/?denied=${zone}`);
}

export const can = (caps: Capabilities, permission: string) => caps.permissions.includes(permission);

/**
 * Branches a screen should offer for a ":branch" permission (review B-1): only those the person works at, the first
 * one being the default. `all` = every branch of the hospital.
 */
export function branchesFor<B extends { id: string }>(caps: Capabilities, permission: string, all: B[]): B[] {
  const scope = caps.branchScopes?.[permission];
  if (!scope) {
    const home = caps.branchIds;
    // hospital-wide, but the person's own branches first (the default)
    return home ? [...all.filter((b) => home.includes(b.id)), ...all.filter((b) => !home.includes(b.id))] : all;
  }
  return all.filter((b) => scope.includes(b.id));
}
export const hasFeature = (caps: Capabilities, feature: string) => caps.features[feature]?.enabled === true;

export function Can({ caps, permission, children, fallback = null }: { caps: Capabilities; permission: string; children: ReactNode; fallback?: ReactNode }) {
  return <>{can(caps, permission) ? children : fallback}</>;
}

export function Feature({ caps, name, children, fallback = null }: { caps: Capabilities; name: string; children: ReactNode; fallback?: ReactNode }) {
  return <>{hasFeature(caps, name) ? children : fallback}</>;
}

// ---------- zone frame ----------

export interface ZoneInfo { name: string; basePath: string }

/**
 * The common page frame for every zone: hospital branding, nav from capabilities (only deployed zones),
 * signed-in user and sign-out. `requireAuth: false` for public pages (landing, login).
 */
export async function ZoneFrame({ zone, path, zones, requireAuth = true, children }: { zone: string; path: string; zones: ZoneInfo[]; requireAuth?: boolean; children: ReactNode }) {
  const [branding, session] = await Promise.all([getBranding(), getSession()]);
  const base = await origin();
  let nav: { key: string; label: string; href: string; active?: boolean }[] = [];
  let banner: ReactNode = null;
  if (requireAuth || session) {
    const caps = await getCapabilities(path);
    if (caps.actor.kind === 'staff') banner = billingBanner(caps, base);
    if (requireAuth && zone !== 'shell') await requireZone(caps, zone);
    const items = visibleNav(caps, zones.map((z) => z.name));
    // the most specific matching item is the current page (so /admin/branches doesn't also light up /admin)
    const current = items.filter((n) => path === n.href || path.startsWith(n.href + '/')).sort((a, b) => b.href.length - a.href.length)[0];
    nav = items.map((n) => ({ key: n.key, label: n.label, href: `${base}${n.href}`, active: n === current }));
  }
  const user = session ? { label: session.email ?? session.name ?? (session.kind === 'patient' ? 'Patient' : 'Staff'), signOutHref: `${base}/auth/logout` } : null;
  return <AppFrame hospital={{ name: branding.name, ...branding.branding }} nav={nav} user={user} signInHref={`${base}/login?next=${encodeURIComponent(path)}`} homeHref={`${base}/`}>{banner}{children}</AppFrame>;
}

const day = (d: string | null) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata' }) : '');

/**
 * The hospital's MediCare subscription, for staff (docs/FEATURES-AND-PLANS.md §4.3): everyone sees read-only states;
 * the account owner also sees overdue payments and the trial end, with a link to pay.
 */
function billingBanner(caps: Capabilities, base: string): ReactNode {
  const b = caps.billing;
  if (!b) return null;
  const owner = caps.permissions.includes('subscription:manage:tenant');
  const pay = owner ? <> <a href={`${base}/account`}>Go to the subscription</a></> : null;
  const box = (tone: 'info' | 'error', text: ReactNode) => <div role="status" aria-label="Subscription" style={{ marginBottom: 16 }}><Alert tone={tone}>{text}{pay}</Alert></div>;
  switch (b.status) {
    case 'SUSPENDED': return box('error', <><strong>Read only:</strong> this hospital&apos;s MediCare subscription is suspended for unpaid invoices. Records can be viewed; nothing new can be booked or added.</>);
    case 'CANCELLED': case 'EXPIRED': return box('error', <><strong>Read only:</strong> this hospital&apos;s MediCare subscription has ended. Records can be viewed; nothing new can be booked or added.</>);
    case 'GRACE': return owner ? box('error', <>Payment overdue: pay by {day(b.graceEndsAt)} or the hospital becomes read-only.</>) : null;
    case 'PAST_DUE': return owner ? box('error', <>The last payment to MediCare failed. We will retry; you can pay now with another card.</>) : null;
    case 'TRIALING': return owner ? box('info', <>Free trial until {day(b.trialEndsAt)}. Add a card to continue after it.</>) : null;
    default: return null;
  }
}
