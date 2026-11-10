# Restore one hospital

**When:** one hospital's data was damaged (a bad bulk change or a bug), and the fix is to go back to a known-good point. Other hospitals are not touched: each has its own database.

**Decide first, with the hospital and the product owner:** anything written after the restore point is lost, unless it is re-entered. Prefer a targeted fix (a migration or a script on the bad rows) when the damage is narrow.

**Targets:** RTO ≤ 1 hour, RPO ≤ 5 minutes with point-in-time recovery, or since last night with the nightly dump. A drill is timed in `mc backup status`: citycare (13.5 MB) restores and checks in about 7 s locally.

## A. From last night's backup (simplest)

1. **Take the hospital offline** in the console (the Hospitals page, "take offline", with a reason). Patients and staff then see that the hospital is offline.
2. **Restore into a checked copy:**
   ```
   mc backup drill <slug> --id <backup id> --keep
   ```
   `mc backup list <slug>` lists the backups. The drill restores into a scratch `drill_*` database on the hospital's own server, then checks every table's row count and every schema version against the backup's record. `--keep` leaves it in place.
3. **Swap the databases.** There is no single command for this yet: it is the open item "mc backup restore". As the server's admin:
   ```sql
   -- no service may hold a connection while the databases are renamed
   SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '<t_slug>';
   ALTER DATABASE "<t_slug>" RENAME TO "<t_slug>_damaged_<date>";
   ALTER DATABASE "<drill db>" RENAME TO "<t_slug>";
   ```
4. **Bring it back:** take the hospital back online in the console. Services reopen their pools.
5. **Rebuild what lives outside the database:** `mc search reindex <slug>`. Then check the analytics warehouse's backfill (`POST /internal/tenants/:id/analytics/backfill`).
6. **Keep the damaged copy** until the hospital confirms the restore, then drop it.

## B. To a point in time (Cloud SQL PITR, up to 7 days back)

Cloud SQL restores a whole **server**, never one hospital, so:
1. **Clone the server** to the chosen time into a new instance. The live server is not touched.
2. **Dump that hospital's database from the clone:**
   ```
   pg_dump -Fc -d <t_slug> -h <clone ip> > /tmp/<slug>.dump
   ```
3. **Restore it into a new database on the live server,** then swap it in as in A.3–A.6.
4. **Delete the clone.**

## Confirm

- The hospital's admin checks the data they care about.
- `mc backup run <slug>`, then `mc backup drill <slug>`, for a fresh good backup.
