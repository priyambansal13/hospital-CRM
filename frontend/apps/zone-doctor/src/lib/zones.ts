import zonesJson from '../../../../zones.json';
import type { ZoneInfo } from '@mc/features';

export const ZONES: ZoneInfo[] = zonesJson.zones.map((z) => ({ name: z.name, basePath: z.basePath }));
export const ZONE_BASES: Record<string, string> = Object.fromEntries(ZONES.map((z) => [z.name, z.basePath]));
