# A migration ring failed

**How releases migrate:**
1. Control, then every server's template.
2. Then ring 0 (internal and test), 1 (pilots), 2 (everyone).
3. Ring 3 (dedicated servers) waits for the Sunday 02:00 IST window.

The first failure stops the run. Hospitals not reached stay on the previous version, which the running code still supports.

## Do

1. **Who is behind, and the error:** `mc migrate status`, and the migration Job's logs in Argo CD (pre-upgrade hook). The failing hospital and migration are named.
2. **Don't rerun blindly.** Common causes:
   - Data in one hospital the migration didn't expect (a NOT NULL or unique constraint): fix the data in that hospital, or make the migration tolerant, and release.
   - A lock timeout on a busy table: rerun out of hours.
   - A server unreachable: [a database server is down](database-server-down.md).
3. **Hold the rest:** `mc migrate --max-ring <n>` migrates only up to a ring. A hospital can be moved to an earlier ring while it is investigated (`mc tenant ring <slug> <n>`).
4. **Rerun after the fix:** `mc migrate` continues from where it stopped. Migrations already applied are skipped.
5. **Never roll a migration back by hand** in one hospital. Write a new forward migration.

## Confirm

`mc migrate status` shows no hospital behind.
