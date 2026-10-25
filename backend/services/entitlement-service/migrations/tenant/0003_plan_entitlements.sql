-- Phase 17: what this hospital's contract gives it (from subscription.contract_changed), and the module lifecycle.
-- ACTIVATING → enable hooks ran → ACTIVE;  DISABLING → disable hooks ran → READ_ONLY (data kept, GET only).
ALTER TABLE tenant_modules DROP CONSTRAINT tenant_modules_state_check;
ALTER TABLE tenant_modules ADD CONSTRAINT tenant_modules_state_check CHECK (state IN ('ACTIVATING','ACTIVE','DISABLING','READ_ONLY','DISABLED'));
ALTER TABLE tenant_modules ADD COLUMN attempts int NOT NULL DEFAULT 0;
ALTER TABLE tenant_modules ADD COLUMN next_attempt_at timestamptz;
ALTER TABLE tenant_modules ADD COLUMN last_error text;
CREATE INDEX tenant_modules_pending ON tenant_modules (next_attempt_at) WHERE state IN ('ACTIVATING','DISABLING');

-- one row: the contract currently applied
CREATE TABLE tenant_plan (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  contract_id uuid NOT NULL,
  seq int NOT NULL,
  plan_code text NOT NULL,
  plan_name text NOT NULL,
  plan_version int NOT NULL,
  edition text NOT NULL,
  addons jsonb NOT NULL DEFAULT '[]',
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- features of the included modules (missing row = on, unlimited)
CREATE TABLE tenant_features (
  feature_key text PRIMARY KEY,
  enabled boolean NOT NULL,
  limit_value bigint
);

-- ranges for plan-bounded settings (the setting editor arrives in Phase 20)
CREATE TABLE tenant_setting_bounds (
  setting_key text PRIMARY KEY,
  bounds jsonb NOT NULL
);
