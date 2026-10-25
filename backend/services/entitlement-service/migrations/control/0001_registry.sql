-- Module registry (control plane), synced from backend/modules/*.module.yaml on startup.
CREATE TABLE modules (
  key text PRIMARY KEY,
  name text NOT NULL,
  version int NOT NULL,
  manifest jsonb NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE permissions (
  code text PRIMARY KEY,
  module_key text NOT NULL REFERENCES modules(key),
  description text NOT NULL
);
CREATE TABLE features (
  key text PRIMARY KEY,
  module_key text NOT NULL REFERENCES modules(key),
  type text NOT NULL CHECK (type IN ('BOOLEAN','LIMIT','METERED')),
  unit text
);
