# A database server is down

**Alert:** `MedicareControlDatabaseUnreachable` (page). For a hospital-only server, the signs are errors for every hospital on it: `TENANT_UNAVAILABLE` and connection errors in the logs, filtered by `tenant`.

**Servers:**
- `pg-1` holds the control plane (`mc_control`, Keycloak) and shared hospitals.
- `pg-2`… are shared servers; dedicated servers serve one group.
- Each is Cloud SQL **regional HA**, with a standby in another Mumbai zone and a read replica in Delhi.

## Do

1. **Is Cloud SQL failing over?** A zone failure fails over to the standby by itself in about a minute. Connections drop and reconnect. Services reopen pools after a refused connection, so wait 2–3 minutes before acting.
2. **Still down:** check the instance's operations and logs in the console:
   - storage full (auto-resize is on, but check);
   - connections at `max_connections`;
   - a long maintenance.
3. **Connections exhausted:**
   - PgBouncer pools (`SHOW POOLS;` in the pgbouncer pod);
   - long-running queries in Query Insights; end them.
   - Then raise `max_connections` for that server in Terraform (`shared_servers.<id>.max_connections`; applying it restarts the instance).
4. **The whole region is affected:** [regional disaster](regional-disaster.md).
5. **Communicate:**
   - `pg-1` down: everything fails (sign-in included): Critical.
   - Another server: "some hospitals". Never name them on the public page.

## Confirm

- `mc_dependency_up{dependency="control_db"}` is 1.
- `mc migrate status` answers.
- A test hospital on that server loads.
