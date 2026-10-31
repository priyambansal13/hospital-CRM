-- Phase 27: custom fields, forms, workflow rules, webhooks, API keys, LIS connector (schema "integration").

-- custom fields on patients and appointments (values live with the record, in its service)
CREATE TABLE field_defs (
  id uuid PRIMARY KEY,
  entity text NOT NULL CHECK (entity IN ('PATIENT','APPOINTMENT')),
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  label text NOT NULL,
  type text NOT NULL CHECK (type IN ('TEXT','NUMBER','DATE','SELECT','BOOLEAN')),
  options jsonb NOT NULL DEFAULT '[]',
  required boolean NOT NULL DEFAULT false,
  help text,
  active boolean NOT NULL DEFAULT true,
  sort int NOT NULL DEFAULT 0,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity, key)
);

-- forms patients fill before a visit (all visits, or one specialty's)
CREATE TABLE forms (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  specialty_code text,
  intro text,
  fields jsonb NOT NULL,
  active boolean NOT NULL DEFAULT true,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX forms_one_active_per_specialty ON forms (coalesce(specialty_code, '*')) WHERE active;

-- workflow rules: trigger → conditions (all must hold) → actions (a fixed list)
CREATE TABLE rules (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  trigger text NOT NULL,
  conditions jsonb NOT NULL DEFAULT '[]',
  actions jsonb NOT NULL,
  active boolean NOT NULL DEFAULT true,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE rule_runs (
  id uuid PRIMARY KEY,
  rule_id uuid NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  event_id uuid NOT NULL,
  trigger text NOT NULL,
  subject text,                    -- e.g. "APT-2026-000123 · Asha Verma"
  matched boolean NOT NULL,
  results jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rule_id, event_id)
);
CREATE INDEX rule_runs_recent ON rule_runs (created_at DESC);
-- per-patient counters the conditions can use (kept from events)
CREATE TABLE patient_counters (
  patient_id uuid PRIMARY KEY,
  no_shows int NOT NULL DEFAULT 0,
  cancellations int NOT NULL DEFAULT 0,
  completed int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- outbound webhooks (and the LIS endpoint, kind LIS)
CREATE TABLE endpoints (
  id uuid PRIMARY KEY,
  kind text NOT NULL DEFAULT 'WEBHOOK' CHECK (kind IN ('WEBHOOK','LIS')),
  name text NOT NULL,
  url text NOT NULL,
  events jsonb NOT NULL DEFAULT '[]',
  secret_enc bytea NOT NULL,
  secret_hint text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX endpoints_one_lis ON endpoints (kind) WHERE kind = 'LIS';
CREATE TABLE deliveries (
  id uuid PRIMARY KEY,
  endpoint_id uuid NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
  event_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','DELIVERED','FAILED')),
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_status int,
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (endpoint_id, event_id)
);
CREATE INDEX deliveries_due ON deliveries (next_attempt_at) WHERE status = 'PENDING';

-- API keys for the FHIR API and the LIS results callback: only a hash is kept
CREATE TABLE api_keys (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  prefix text NOT NULL UNIQUE,
  key_hash text NOT NULL,
  scopes jsonb NOT NULL,
  created_by uuid NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
