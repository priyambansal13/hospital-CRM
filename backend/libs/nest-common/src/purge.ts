import type pg from 'pg';

/**
 * Crypto-shredding (review H-1): a purged hospital's data keys are destroyed, so its encrypted fields can never be
 * read again, from any copy or backup. Used by every service that keeps a `tenant_keys` table.
 */
export async function destroyTenantKeys(control: pg.Pool, tenantId: string) {
  const { rowCount } = await control.query('DELETE FROM tenant_keys WHERE tenant_id = $1', [tenantId]);
  return rowCount ?? 0;
}
