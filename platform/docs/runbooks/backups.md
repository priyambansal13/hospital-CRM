# Backups and restore drills

**Alerts:**
- `MedicareBackupMissing` (ticket, no backup for 26 h) and `…TwoNights` (page, 48 h);
- `MedicareRestoreDrillFailed` (page);
- `MedicareRestoreDrillsStale` (ticket, no drill for 8 days).

**How it works** (docs/MULTI-TENANCY.md §8):
- `backup-nightly` (02:00 IST) dumps every hospital, encrypted with its own key, to the backups bucket in Delhi.
- `restore-drill` (Sunday 04:00 IST) restores a sample into a scratch database and compares every table's row count and every schema version.
- Cloud SQL point-in-time recovery covers each whole server for 7 days.

## Backup missing

1. `mc backup status`: which hospitals, and when their last backup ran.
2. **The CronJob:** `kubectl -n medicare-production get jobs | grep backup-nightly`, then the failed job's logs. Common causes:
   - the bucket mount (Cloud Storage FUSE, the `medicare-ops` Workload Identity);
   - a server unreachable ([a database server is down](database-server-down.md));
   - the backup key wrapper (KMS permission for `medicare-ops`).
3. **Run one now:** `mc backup run <slug>` (in the ops image), or `--all`.
4. **A hospital created today has no backup yet:** the age counts from its creation, so a new hospital only alerts if the first night is missed.

## Restore drill failed

**This is a page:** a backup we can't restore is not a backup.
1. `mc backup status` shows the failed drill. `mc backup drill <slug> --id <backup>` runs it again and prints what differed: row counts, schema versions, checksum or decryption.
2. **Checksum or decryption failure:** the file is damaged or the key is wrong. Run a fresh `mc backup run <slug>` now, then drill that one.
3. **Counts differ:** the dump or the snapshot is wrong. Keep the evidence (`--keep` leaves the scratch database), and open a bug at high priority.
4. **Until it is fixed,** the server's point-in-time recovery still protects that hospital. Check that it is on for the server.

## Confirm

- `mc backup status` shows a backup in the last 26 h and a passing drill.
- The alerts clear.
