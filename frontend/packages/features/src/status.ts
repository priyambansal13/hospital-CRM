import 'server-only';
import { api } from '@mc/bff';

/** The public status (tenant-service GET v1/status, docs/OPERATIONS.md §5). */
export type ComponentState = 'operational' | 'degraded' | 'partial_outage' | 'major_outage' | 'maintenance';
export interface PlatformStatus {
  updatedAt: string; overall: ComponentState;
  components: { key: string; name: string; state: ComponentState }[];
  incidents: { id: string; title: string; impact: 'MINOR' | 'MAJOR' | 'CRITICAL' | 'MAINTENANCE'; components: string[]; status: string; startsAt: string; endsAt: string | null; resolvedAt: string | null; updatedAt: string; updates: { status: string; message: string; at: string }[] }[];
}
export const STATE_TEXT: Record<ComponentState, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  operational: { label: 'Working normally', tone: 'success' },
  maintenance: { label: 'Planned maintenance', tone: 'neutral' },
  degraded: { label: 'Some things are slow or failing', tone: 'warning' },
  partial_outage: { label: 'Partly down', tone: 'danger' },
  major_outage: { label: 'Down', tone: 'danger' },
};

export const platformStatus = (timeoutMs = 2500) => api<PlatformStatus>('/api/tenant/v1/status', { timeoutMs });

let memo: { at: number; value: PlatformStatus['incidents'] } = { at: 0, value: [] };
/**
 * Incidents and maintenance happening now, for the staff banner: kept for 30 s in this process, and never more than
 * a second's wait (a slow status API must not slow every staff page).
 */
export async function activeIncidents(): Promise<PlatformStatus['incidents']> {
  if (Date.now() - memo.at < 30_000) return memo.value;
  const s = await platformStatus(1000).catch(() => null);
  const now = Date.now();
  memo = { at: now, value: s ? s.incidents.filter((i) => i.status !== 'RESOLVED' && (i.status !== 'SCHEDULED' || +new Date(i.startsAt) - now < 24 * 3600_000)) : memo.value };
  return memo.value;
}
