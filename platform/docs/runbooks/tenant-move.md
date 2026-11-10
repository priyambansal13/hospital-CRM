# Move a hospital to another database server

**When:**
- a hospital outgrows a shared server;
- an Enterprise contract starts (its dedicated server);
- a server is being emptied.

**What the hospital notices:** about 5 seconds read-only (tested by `mc test servers`). Writes get 503 "under maintenance for a moment"; reading keeps working; nothing accepted is lost.

## Before

1. The target exists and is registered: `mc server list` (`mc server add <id> --pooled … --direct … --peer … [--kind DEDICATED]`).
2. The hospital is on the current schema everywhere: `mc migrate status`.
3. **Pick a quiet time**, outside 09:00–12:00 and 17:00–20:00 IST.
4. **Large hospitals:** the initial copy takes time, but the read-only part doesn't grow with size.

## Move

```
mc tenant move <slug> <server>
```

**Steps it takes:**
1. A pre-move backup.
2. An empty copy on the target from its template.
3. Logical replication, then the initial copy.
4. READ_ONLY, then a fence: CONNECT is revoked from every service role.
5. Catch up, then check that row counts and per-table checksums are equal.
6. Sequences, then the catalog switch, then ACTIVE.

**If anything fails before the switch, it rolls back by itself.** Each step is recorded in `tenant_moves`.

## After

- **The old copy** is renamed `moved_<db>_<time>` and closed to connections. It is kept for the rollback window and never dropped by the tool.
  - Drop it by hand after 7 days, once the hospital's first backup on the new server has passed a drill (`mc backup drill <slug>`).
- **Confirm:**
  - the hospital loads;
  - `mc tenant list` shows the new server;
  - the next nightly backup runs from the new server.
