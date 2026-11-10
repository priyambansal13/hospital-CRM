# Regional disaster: run from Delhi

**When:** Mumbai (`asia-south1`) is lost for hours, as declared by Google Cloud's status page or by our own checks failing from every region. **The incident lead decides**, because it costs data written after the last replicated change.

**Targets:** RPO ≤ 5 minutes (the Delhi replicas lag by seconds) and RTO ≤ 1 hour (HLD §9). Both are measured only once a DR test has been run in a real project: **open item**.

## What is already in Delhi (`asia-south2`)

- A read replica of every Postgres server (`*-dr`; Terraform `dr_replicas`).
- Per-hospital backups (the backups bucket).
- Cloud SQL server backups, and the secret replicas.
- The status page bucket.

## Steps

1. **Status page** (it is served from Delhi): Critical, "MediCare is down; we are moving to our second region".
2. **Promote each replica:**
   ```
   gcloud sql instances promote-replica medicare-production-<id>-dr
   ```
   It becomes a standalone server.
3. **A cluster in Delhi:** apply the Terraform with `region = "asia-south2"` into the same project. The network, GKE, Redis and Kafka are new: Redis starts empty, so patients sign in again; Kafka starts empty, and the outboxes still hold unpublished events.
4. **Point the servers' addresses** (`db_servers` in `mc_control`, now on the promoted `pg-1`) at the promoted instances (`mc server add` with the new addresses), and deploy the apps (Argo CD, the production values with the Delhi registry and addresses).
5. **Search:** `mc search reindex --all`. Analytics backfills from the services.
6. **DNS:** move the apex and `*.<domain>` to the new ingress address.
7. **When Mumbai is back,** don't fail back in a hurry. Plan a move back like a migration, with fresh replicas from Delhi to Mumbai.
