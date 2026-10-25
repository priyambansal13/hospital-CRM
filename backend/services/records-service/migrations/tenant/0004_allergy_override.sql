-- Prescriptions that knowingly go against a recorded allergy keep the doctor's reason (docs/ROLE-FLOWS-AND-GAPS.md C-3).
ALTER TABLE prescriptions ADD COLUMN allergy_override_reason text;
