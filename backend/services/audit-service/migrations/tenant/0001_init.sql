-- Audit log, in each hospital's own database (schema "audit"). docs/LLD.md §15.
-- Append-only (a trigger refuses UPDATE / DELETE / TRUNCATE, even for the owner) and hash-chained:
--   hash = SHA-256(prev_hash || canonical row), so any edit or removal breaks the chain (GET /v1/audit/verify).
CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL,
  source text NOT NULL,                       -- service that wrote it
  actor_id text NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('staff','patient','system')),
  actor_name text,                            -- snapshot (shown to patients: "Dr. Asha Rao")
  action text NOT NULL,                       -- READ | CREATE | UPDATE | SIGN | AMEND | EXPORT | BREAK_GLASS | LOOKUP | DENIED
  resource_type text NOT NULL,
  resource_id uuid,
  patient_id uuid,                            -- "who looked at my record?"
  purpose text NOT NULL,                      -- TREATMENT | BREAK_GLASS | PATIENT_SELF | ADMIN | NONE
  request_id text,
  ip text,
  changes jsonb,                              -- field names only, never clinical text
  prev_hash bytea NOT NULL,
  hash bytea NOT NULL
);
CREATE INDEX ON audit_log (patient_id, occurred_at DESC);
CREATE INDEX ON audit_log (actor_id, occurred_at DESC);
CREATE INDEX ON audit_log (occurred_at DESC);

CREATE FUNCTION audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (% refused)', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();
