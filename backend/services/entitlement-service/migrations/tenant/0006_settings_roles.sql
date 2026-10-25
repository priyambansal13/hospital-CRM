-- Phase 20: hospital settings (within the plan's bounds) and the role editor.
CREATE TABLE tenant_settings (
  setting_key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- custom roles: copied from a system role (or empty), edited by the hospital
ALTER TABLE roles ADD COLUMN based_on text;
ALTER TABLE roles ADD COLUMN description text;
ALTER TABLE roles ADD COLUMN updated_by text;
ALTER TABLE roles ADD COLUMN updated_at timestamptz;
-- who changed which role's permissions, and how (the hospital's own audit of access rights)
CREATE TABLE role_changes (
  id bigserial PRIMARY KEY,
  role_code text NOT NULL,
  action text NOT NULL,
  added text[] NOT NULL DEFAULT '{}',
  removed text[] NOT NULL DEFAULT '{}',
  by_user text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
