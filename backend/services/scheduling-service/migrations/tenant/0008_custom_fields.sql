-- Phase 27: custom fields on appointments, the patient's pre-visit form answers (with the questions they answered),
-- doctors' specialties (which form applies), and patients a workflow rule asked to pay online when they book
ALTER TABLE appointments ADD COLUMN custom_fields jsonb NOT NULL DEFAULT '{}';
ALTER TABLE appointments ADD COLUMN form_answers jsonb;
ALTER TABLE doctors ADD COLUMN specialty_codes text[] NOT NULL DEFAULT '{}';
CREATE TABLE patient_flags (
  patient_id uuid PRIMARY KEY,
  prepay_required boolean NOT NULL DEFAULT false,
  reason text,
  set_by_rule uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
