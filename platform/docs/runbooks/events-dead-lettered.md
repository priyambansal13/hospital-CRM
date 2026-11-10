# Events dead-lettered

**Alert:** `MedicareEventsDeadLettered` (ticket): a consumer failed an event three times (with backoff) and sent it to `<topic>.dlq`.

## Do

1. **See what failed:** `mc events dlq` (counts and the last error per topic and consumer), or the `mc_dlq_messages_total{topic,consumer}` series.
2. **Read the error.** Common ones:
   - `tenant … is SUSPENDED` or `DELETED`: the hospital went offline between writing and handling. Usually harmless: it doesn't need replaying.
   - An upstream 401 or 5xx (Keycloak, another service): fix that first. One example, fixed 2026-11-10: Keycloak rejected a cached admin token, and iam-service now retries once with a new one.
   - Validation or schema errors: a bug in the producer or consumer. Fix and release first.
3. **Replay once it is fixed:** `mc events replay <topic> --consumer <group>` (also `--since <iso date>`, `--max N`, `--dry-run`). Consumers deduplicate, so replaying an event that already succeeded elsewhere is safe.
4. **A whole consumer group was wrong for a while:** stop the service, run `mc events reset <group>` (replays from the start; dedupe makes it safe), then start it.

## Confirm

- `mc events dlq` shows nothing new for that consumer.
- The thing the event was for happened, for example the hospital's login organisation exists, or the confirmation went out.
