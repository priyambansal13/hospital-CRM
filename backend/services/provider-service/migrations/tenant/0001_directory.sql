-- Doctor directory, in each hospital's own database (schema "provider"). pg_trgm is installed in public by `mc db bootstrap`.
CREATE TABLE specialties (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z_]{2,40}$'),
  name text NOT NULL,
  description text,
  active boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Read model of the hospital's branches, kept in sync from tenant.events (never written by this service's API).
CREATE TABLE branches (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  active boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE doctors (
  id uuid PRIMARY KEY,
  user_id uuid UNIQUE,                       -- staff login (Keycloak id), set at onboarding
  email text NOT NULL UNIQUE,
  full_name text NOT NULL,
  gender text CHECK (gender IN ('FEMALE','MALE','OTHER')),
  registration_no text NOT NULL UNIQUE,      -- medical council registration
  qualifications text[] NOT NULL DEFAULT '{}',
  experience_years smallint CHECK (experience_years BETWEEN 0 AND 70),
  languages text[] NOT NULL DEFAULT '{}',
  bio text,
  photo_url text,
  consult_modes text[] NOT NULL DEFAULT '{IN_PERSON}',
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','INACTIVE')),  -- only ACTIVE is public
  version int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX doctors_name_trgm ON doctors USING gin (full_name public.gin_trgm_ops);
CREATE INDEX doctors_status ON doctors (status);

CREATE TABLE doctor_specialties (
  doctor_id uuid NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  specialty_id uuid NOT NULL REFERENCES specialties(id),
  is_primary boolean NOT NULL DEFAULT false,
  PRIMARY KEY (doctor_id, specialty_id)
);
CREATE INDEX ON doctor_specialties (specialty_id);

CREATE TABLE doctor_branches (
  doctor_id uuid NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL,                   -- references the branches read model by id (no FK across services)
  consultation_fee numeric(10,2) NOT NULL CHECK (consultation_fee >= 0),
  followup_fee numeric(10,2) CHECK (followup_fee >= 0),
  PRIMARY KEY (doctor_id, branch_id)
);
CREATE INDEX ON doctor_branches (branch_id);
