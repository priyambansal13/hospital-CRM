-- Patients, in each hospital's own database (schema "patient"). An account (the person who signs in with their
-- phone) owns a "self" record and any number of dependents (children, parents) in this hospital.
CREATE SEQUENCE mrn_seq START 100001;

CREATE TABLE patients (
  id uuid PRIMARY KEY,
  account_person_id uuid NOT NULL,           -- the signed-in person who manages this record (iam person id)
  guardian_id uuid REFERENCES patients(id),  -- NULL for the account holder's own record
  relation text CHECK (relation IN ('SELF','CHILD','SPOUSE','PARENT','SIBLING','OTHER')),
  mrn text NOT NULL UNIQUE,                  -- hospital medical record number
  full_name text NOT NULL CHECK (length(full_name) BETWEEN 2 AND 120),
  dob date NOT NULL CHECK (dob <= current_date),
  gender text CHECK (gender IN ('FEMALE','MALE','OTHER')),
  phone text,
  email text,
  version int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON patients (account_person_id);
-- one "self" record per account
CREATE UNIQUE INDEX patients_one_self ON patients (account_person_id) WHERE guardian_id IS NULL;
