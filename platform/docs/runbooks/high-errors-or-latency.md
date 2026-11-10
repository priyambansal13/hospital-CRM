# High errors or latency

**Alerts:**
- `MedicareErrorBudgetBurnFast` / `Slow` (page) and `…Ticket`: more than 0.1% of a service's requests return 5xx.
- `MedicareBookingSlow`: more than 5% of bookings take over 500 ms.

**What patients see:** depends on the service. Booking errors show "something went wrong, try again", and slow bookings make the slot picker spin.

## Find the cause (10 minutes)

1. **Which service, which routes.** In Grafana or Prometheus:
   `sum by (route, status) (rate(mc_http_request_duration_seconds_count{job="<service>",status=~"5.."}[5m]))`
2. **Did something change?** Check the last deploy in Argo CD (the `medicare-production` apps), the last migration ring (`mc migrate status`), and any feature switched on for a hospital (console audit).
3. **Errors in the logs:** `level:error` for the service. The problem code tells the story:
   - `DEPENDENCY_UNAVAILABLE`: Redis → [Redis outage](redis-outage.md).
   - `TENANT_UNAVAILABLE` or `TENANT_READ_ONLY`: a hospital being moved, or offline.
   - `PAYMENTS_UNAVAILABLE`: [payment provider](payments-outage.md).
   - `ENTITLEMENTS_UNAVAILABLE`: entitlement-service is down → [service down](service-down.md).
   - `INTERNAL`: a bug; the log line has the stack and the `requestId`.
4. **One hospital or all?** Filter the logs by `tenant`. One hospital usually means its database server ([database server down](database-server-down.md)) or a module change.
5. **Latency only:**
   - Cloud SQL Query Insights for the server (slow queries, lock waits);
   - CPU and memory of the pods;
   - the database connections in PgBouncer (`SHOW POOLS`).

## Fix

- **A bad release:** roll back in Argo CD to the previous version. Releases are images with immutable tags, so a rollback is always safe for the code. A migration is never rolled back: migrations are written to be compatible with the previous release.
- **One hospital overloading a shared server:** move it to a dedicated or quieter server ([tenant move](tenant-move.md)).
- **Pods at their limits:** raise `autoscaling.maxReplicas` for the service, or its resources.
- **A slow query:** an index migration is a normal release. Until then, the lock or the query can be ended in Cloud SQL.

## Confirm

- `job:mc_request_errors:ratio_rate5m{job="<service>"}` is back under 0.001.
- The latency ratio (`slo:mc_booking_slow:ratio_rate5m`) is under 0.05.
- The status-page incident is resolved.
