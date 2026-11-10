# Redis outage

**Alert:** `MedicareRedisUnreachable` (page): a service's health check can't reach Redis (Memorystore).

## What still works, and what doesn't (tested by `mc test chaos`)

| Works | Refused fast with 503 `DEPENDENCY_UNAVAILABLE` ("try again in a minute") |
|---|---|
| Reading: doctor lists, a signed-in patient's appointments and records, staff screens | New patient sign-in codes (OTP), token refresh |
| Every instance stays **ready**: Redis is not part of readiness, so reads keep being served | Bookings and other requests with an Idempotency-Key, payments |
| Permissions: worked out from the database when the cache is missing | Signup, demo-request and chat rate limits; usage metering |

Requests fail within about a second (`REDIS_COMMAND_TIMEOUT_MS`, default 1000), never hang. Everything works again within seconds of Redis returning, **without restarting anything**.

## Do

1. **Post on the status page:** components sign-in, booking and payments, impact Major. "Signing in with a new code, booking and online payment fail. People already signed in can still see their appointments and records."
2. **Memorystore:** check the instance in the console. It is STANDARD_HA, so a zone failure fails over to the replica in under a minute. Still down after 5 minutes:
   - look at Memorystore's own incident page and the instance's maintenance events;
   - check the VPC peering (private service access) and the instance's authorized network.
3. **Memory full** (`maxmemory` reached, writes refused): the policy is `volatile-lru`, so keys with a TTL go first. Refresh tokens (30 days) and idempotency keys (24 hours) dominate. Raise `redis_memory_gb` in Terraform (applies online for STANDARD_HA).
4. **What the outage cost:**
   - idempotency keys written just before the outage may be lost, so a retried booking could, in theory, run twice. The slot locking in the database still prevents a double booking of the same time;
   - a lost refresh-token store signs patients out: they sign in again with a code.

## Confirm

- `mc_dependency_up{dependency="redis"}` is 1 on every job.
- A test booking works on a test hospital.
- Resolve the status-page incident.
