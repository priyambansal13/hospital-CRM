-- Tenant catalog (control plane): which hospitals exist and where their databases live.
CREATE TABLE tenants (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z][a-z0-9-]{2,30}$'),
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('PROVISIONING','ACTIVE','READ_ONLY','SUSPENDED','DELETED')),
  db_name text NOT NULL UNIQUE,
  db_host text NOT NULL,
  db_port int NOT NULL,
  region text NOT NULL DEFAULT 'in-1',
  plan text,
  admin_email text NOT NULL,
  branding jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_domains (
  host text PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  is_primary boolean NOT NULL DEFAULT false
);
CREATE INDEX ON tenant_domains (tenant_id);

-- written by the migration orchestrator (mc migrate)
CREATE TABLE tenant_schema_versions (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  service text NOT NULL,
  version text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, service)
);

-- provisioning saga ledger: each step is idempotent and recorded (docs/MULTI-TENANCY.md §6)
CREATE TABLE provisioning_steps (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  step text NOT NULL,
  status text NOT NULL CHECK (status IN ('DONE','FAILED')),
  detail text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, step)
);
