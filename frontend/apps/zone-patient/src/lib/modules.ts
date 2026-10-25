import { api } from '@mc/bff';

/** What this hospital offers right now (also for signed-out visitors): modules in use and read-only ones. */
export const publicModules = () => api<{ modules: string[]; readOnly: string[] }>('/api/entitlement/v1/public/modules');
