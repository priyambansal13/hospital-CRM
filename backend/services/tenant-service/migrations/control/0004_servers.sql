-- Production readiness (Phase 30; docs/MULTI-TENANCY.md §3.4–3.5, §8).
-- Postgres servers hospitals live on. Services reach a server through its pooler (pooled_*), migrations and admin
-- tools connect directly (direct_*), and servers reach each other (logical replication for moves) at peer_*.
-- SHARED servers take new hospitals (least full first); a DEDICATED server only gets hospitals placed on it by name.
CREATE TABLE db_servers (
  id text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9-]{1,30}$'),
  region text NOT NULL DEFAULT 'in-1',
  kind text NOT NULL DEFAULT 'SHARED' CHECK (kind IN ('SHARED','DEDICATED')),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
  pooled_host text NOT NULL, pooled_port int NOT NULL,
  direct_host text NOT NULL, direct_port int NOT NULL,
  peer_host text NOT NULL, peer_port int NOT NULL,
  capacity int NOT NULL DEFAULT 500 CHECK (capacity > 0),
  maintenance_window text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Release rings (§3.4): 0 internal/test hospitals, 1 pilots, 2 everyone else, 3 dedicated servers (in their window).
ALTER TABLE tenants ADD COLUMN db_server text REFERENCES db_servers(id);
ALTER TABLE tenants ADD COLUMN ring smallint NOT NULL DEFAULT 2 CHECK (ring BETWEEN 0 AND 3);

-- Moving a hospital to another server: one row per move, each step recorded (mc tenant move).
CREATE TABLE tenant_moves (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  from_server text NOT NULL REFERENCES db_servers(id),
  to_server text NOT NULL REFERENCES db_servers(id),
  status text NOT NULL CHECK (status IN ('RUNNING','DONE','FAILED')),
  step text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  read_only_ms int,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX ON tenant_moves (tenant_id, started_at DESC);

-- Per-hospital backups (nightly pg_dump, encrypted with the hospital's backup key) and restore drills.
CREATE TABLE tenant_backups (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  server_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('NIGHTLY','MANUAL','PRE_MOVE')),
  location text NOT NULL,
  bytes bigint NOT NULL,
  sha256 text NOT NULL,
  tables jsonb NOT NULL,
  versions jsonb NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  drill_at timestamptz,
  drill_ok boolean,
  drill_seconds numeric(8,1),
  drill_report jsonb
);
CREATE INDEX ON tenant_backups (tenant_id, started_at DESC);

-- Each hospital's backup key, wrapped with the master key (Cloud KMS in production). Purging a hospital destroys
-- it, so every backup of that hospital becomes unreadable (crypto-shredding).
CREATE TABLE tenant_backup_keys (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  wrapped text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
