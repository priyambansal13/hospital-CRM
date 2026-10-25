-- In each hospital's own database, schema "iam".
CREATE TABLE staff_members (
  user_id uuid PRIMARY KEY,          -- Keycloak user id
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('INVITED','ACTIVE','DISABLED')),
  invited_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE patient_accounts (
  person_id uuid PRIMARY KEY,        -- global person id (control plane)
  phone text NOT NULL,
  first_login_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz NOT NULL DEFAULT now()
);
