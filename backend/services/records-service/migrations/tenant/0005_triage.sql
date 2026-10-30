-- Nurse triage before the doctor sees the patient (docs/ROLE-FLOWS-AND-GAPS.md: nurse vitals and triage).
-- One per appointment; copied into the visit note when the doctor opens it. The complaint is encrypted like notes.
CREATE TABLE triage (
  appointment_id uuid PRIMARY KEY,
  patient_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  doctor_id uuid NOT NULL,
  vitals jsonb NOT NULL DEFAULT '{}',
  priority text NOT NULL CHECK (priority IN ('ROUTINE','URGENT','EMERGENCY')),
  complaint_enc bytea,
  recorded_by uuid NOT NULL,
  recorded_by_name text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1
);
CREATE INDEX ON triage (doctor_id, recorded_at DESC);
