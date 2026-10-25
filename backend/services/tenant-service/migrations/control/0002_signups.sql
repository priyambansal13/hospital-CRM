-- Phase 20: self-serve signup. A signup is confirmed by a link e-mailed to the owner before anything is provisioned
-- (no databases or logins for unconfirmed addresses); the link's token is stored hashed.
CREATE TABLE signups (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  slug text NOT NULL CHECK (slug ~ '^[a-z][a-z0-9-]{2,30}$'),
  hospital_name text NOT NULL,
  admin_name text NOT NULL,
  admin_email text NOT NULL,
  phone text,
  plan_code text NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING','PROVISIONING','READY','FAILED','EXPIRED')),
  error text,
  tenant_id uuid REFERENCES tenants(id),
  ip text,
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  ready_at timestamptz,
  expires_at timestamptz NOT NULL
);
-- one live signup per subdomain (a confirmed one owns it; an expired one frees it)
CREATE UNIQUE INDEX signups_slug_live ON signups (slug) WHERE status IN ('PENDING','PROVISIONING','READY');
CREATE INDEX ON signups (admin_email, created_at);

-- where a hospital came from: sales-led (CLI / console) or self-serve signup (starts a trial)
ALTER TABLE tenants ADD COLUMN source text NOT NULL DEFAULT 'SALES' CHECK (source IN ('SALES','SIGNUP'));
-- the setup wizard: done when the owner finishes it (steps themselves are read from the data)
ALTER TABLE tenants ADD COLUMN setup_completed_at timestamptz;

-- custom domains (Enterprise): verified by a DNS TXT record before they serve the hospital
ALTER TABLE tenant_domains ADD COLUMN status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('PENDING','ACTIVE'));
ALTER TABLE tenant_domains ADD COLUMN verify_token text;
ALTER TABLE tenant_domains ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE tenant_domains ADD COLUMN verified_at timestamptz;
