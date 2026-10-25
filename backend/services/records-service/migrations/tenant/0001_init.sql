-- Clinical records, in each hospital's own database (schema "records"). docs/LLD.md §3.6, §7.
-- Free-text clinical fields are encrypted in the application (AES-256-GCM, the hospital's own data key):
-- *_enc columns. Codes, dates and drug names stay queryable.

-- Read models (from events)
CREATE TABLE doctors (
  id uuid PRIMARY KEY, user_id uuid UNIQUE, name text NOT NULL, status text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE patients (
  id uuid PRIMARY KEY, account_person_id uuid NOT NULL, mrn text NOT NULL, name text NOT NULL,
  dob date, gender text, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON patients (account_person_id);
CREATE UNIQUE INDEX ON patients (mrn);
-- appointments, for the treating-relationship check (doctor ↔ patient within the window)
CREATE TABLE care_appointments (
  appointment_id uuid PRIMARY KEY, doctor_id uuid NOT NULL, patient_id uuid NOT NULL, branch_id uuid NOT NULL,
  status text NOT NULL, mode text, starts_at timestamptz NOT NULL, appointment_no text, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON care_appointments (doctor_id, patient_id, starts_at DESC);

CREATE SEQUENCE prescription_seq START 1;

CREATE TABLE encounters (
  id uuid PRIMARY KEY,
  appointment_id uuid UNIQUE,
  patient_id uuid NOT NULL,
  doctor_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  vitals jsonb,                                   -- {bp:"120/80", pulse:72, tempC:36.8, weightKg:70, spo2:98}
  complaint_enc bytea,                            -- chief complaint
  notes_enc bytea,                                -- clinical notes
  status text NOT NULL CHECK (status IN ('OPEN','SIGNED','AMENDED')),
  signed_at timestamptz,
  version int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON encounters (patient_id, started_at DESC);
CREATE INDEX ON encounters (doctor_id, patient_id);

CREATE TABLE diagnoses (
  id uuid PRIMARY KEY,
  encounter_id uuid NOT NULL REFERENCES encounters(id),
  icd10_code text,
  description text NOT NULL,
  is_primary boolean NOT NULL DEFAULT false
);
CREATE INDEX ON diagnoses (encounter_id);

-- signed records are never edited in place: an amendment keeps what it replaced (encrypted) and why
CREATE TABLE encounter_amendments (
  id uuid PRIMARY KEY,
  encounter_id uuid NOT NULL REFERENCES encounters(id),
  reason text NOT NULL,
  previous_enc bytea NOT NULL,                    -- the encounter's clinical content before this amendment
  changed text[] NOT NULL,
  amended_by uuid NOT NULL,
  amended_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE prescriptions (
  id uuid PRIMARY KEY,
  prescription_no text NOT NULL UNIQUE,           -- RX-2026-000123
  encounter_id uuid NOT NULL REFERENCES encounters(id),
  patient_id uuid NOT NULL,
  doctor_id uuid NOT NULL,
  advice_enc bytea,
  follow_up_on date,
  issued_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON prescriptions (patient_id, issued_at DESC);
CREATE TABLE prescription_items (
  id uuid PRIMARY KEY,
  prescription_id uuid NOT NULL REFERENCES prescriptions(id),
  position smallint NOT NULL,
  drug_name text NOT NULL,
  strength text,
  form text,
  dosage text NOT NULL,                           -- "1-0-1"
  duration_days smallint,
  instructions text                               -- "after food"
);

-- emergency access without a treating relationship: time-boxed, with a reason, always audited
CREATE TABLE break_glass_grants (
  id uuid PRIMARY KEY,
  doctor_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  reason text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX ON break_glass_grants (doctor_id, patient_id, expires_at DESC);
