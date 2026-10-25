-- Allergies and consents (Phase 13). docs/LLD.md §3.2.
CREATE TABLE allergies (
  id uuid PRIMARY KEY,
  patient_id uuid NOT NULL REFERENCES patients(id),
  substance text NOT NULL CHECK (length(substance) BETWEEN 2 AND 100),
  severity text NOT NULL CHECK (severity IN ('MILD','MODERATE','SEVERE','UNKNOWN')),
  reaction text,
  recorded_by uuid NOT NULL,
  recorded_by_kind text NOT NULL CHECK (recorded_by_kind IN ('patient','staff')),
  recorded_by_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz
);
CREATE INDEX ON allergies (patient_id) WHERE removed_at IS NULL;
CREATE UNIQUE INDEX allergies_one_per_substance ON allergies (patient_id, lower(substance)) WHERE removed_at IS NULL;

-- A patient shares part of their record with a doctor for a while (revocable at any time)
CREATE TABLE consents (
  id uuid PRIMARY KEY,
  patient_id uuid NOT NULL REFERENCES patients(id),
  grantee_type text NOT NULL DEFAULT 'DOCTOR' CHECK (grantee_type IN ('DOCTOR')),
  grantee_id uuid NOT NULL,
  grantee_name text NOT NULL,
  scope text[] NOT NULL CHECK (cardinality(scope) > 0 AND scope <@ ARRAY['NOTES','PRESCRIPTIONS','DOCUMENTS']),
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz NOT NULL,
  granted_by uuid NOT NULL,
  revoked_at timestamptz,
  CHECK (valid_until > valid_from)
);
CREATE INDEX ON consents (patient_id);
CREATE INDEX ON consents (grantee_id, patient_id) WHERE revoked_at IS NULL;
