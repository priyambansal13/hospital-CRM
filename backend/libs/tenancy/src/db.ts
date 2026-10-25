import pg from 'pg';

export type Queryable = Pick<pg.PoolClient, 'query'>;

export interface ServiceDbConfig {
  /** the service's schema name, e.g. "scheduling"; role is svc_<schema> */
  schema: string;
  user?: string;
  password?: string;
}

export function serviceDbConfig(schema: string): Required<ServiceDbConfig> {
  const password = process.env[`DB_PASSWORD_SVC_${schema.toUpperCase()}`];
  if (!password) throw new Error(`missing DB_PASSWORD_SVC_${schema.toUpperCase()} (run mc configure)`);
  return { schema, user: `svc_${schema}`, password };
}

/**
 * Run fn in a transaction on a pooled client. While checked out, a client is not covered by the pool's 'error'
 * listener (survive()): if the connection drops between queries (database restart), pg emits 'error' on the client
 * and, unhandled, that would crash the service. We listen for it, fail the transaction, and discard the client.
 */
export async function withTx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  let broken: Error | undefined;
  const onError = (e: Error) => { broken = e; };
  c.on('error', onError);
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    if (!broken) await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.off('error', onError);
    c.release(broken);
  }
}

/** Pool on the control-plane database (mc_control), search_path = the service's control schema. */
export function controlPool(schema: string, opts: { max?: number } = {}) {
  const cfg = serviceDbConfig(schema);
  const pool = new pg.Pool({
    host: process.env.PG_HOST ?? 'localhost',
    port: Number(process.env.PG_PORT ?? 61432),
    database: process.env.CONTROL_DB ?? 'mc_control',
    user: cfg.user,
    password: cfg.password,
    max: opts.max ?? 10,
    // search_path comes from the role (ALTER ROLE svc_x SET search_path): works through PgBouncer
    application_name: `svc_${schema}`,
  });
  return survive(pool, `control:${schema}`);
}

/**
 * An idle pooled client can lose its connection (database restart, failover, network). pg emits 'error' on the pool;
 * without a listener Node crashes the whole service. Log it and let the pool reconnect on the next query.
 */
export function survive<T extends pg.Pool | pg.Client>(db: T, name: string): T {
  (db as pg.Pool).on('error', (e: Error) => console.warn(JSON.stringify({ level: 'warn', context: 'db', msg: `${name}: connection lost (${e.message}); reconnecting on next use` })));
  return db;
}
