-- In each hospital's own database, schema "entitlement".
CREATE TABLE roles (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z_]{3,40}$'),
  name text NOT NULL,
  is_system boolean NOT NULL DEFAULT false,
  grants_all boolean NOT NULL DEFAULT false,      -- TENANT_ADMIN: every permission of every active module
  customized boolean NOT NULL DEFAULT false,      -- edited by the hospital: template updates no longer applied
  home text NOT NULL DEFAULT '/',
  version int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE role_permissions (
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_code text NOT NULL,
  PRIMARY KEY (role_id, permission_code)
);
CREATE TABLE user_roles (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  role_id uuid NOT NULL REFERENCES roles(id),
  branch_id uuid,                                  -- NULL = all branches
  valid_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX user_roles_unique ON user_roles (user_id, role_id, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'));
CREATE INDEX ON user_roles (user_id);
CREATE TABLE tenant_modules (
  module_key text PRIMARY KEY,
  state text NOT NULL CHECK (state IN ('ACTIVATING','ACTIVE','DISABLING','DISABLED')),
  source text NOT NULL CHECK (source IN ('PLAN','ADDON','OVERRIDE','TRIAL')),
  since timestamptz NOT NULL DEFAULT now()
);
