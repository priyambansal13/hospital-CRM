-- Global identity (control plane, no clinical data): one person per phone across all hospitals,
-- one staff user per Keycloak account, and which hospitals each staff user belongs to.
CREATE TABLE persons (
  id uuid PRIMARY KEY,
  phone text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE staff_users (
  id uuid PRIMARY KEY,               -- Keycloak user id (token sub)
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE staff_memberships (
  user_id uuid NOT NULL REFERENCES staff_users(id),
  tenant_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tenant_id)
);
-- ES256 keys for patient tokens (production: KMS-held keys, rotated)
CREATE TABLE signing_keys (
  kid text PRIMARY KEY,
  private_jwk jsonb NOT NULL,
  public_jwk jsonb NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
