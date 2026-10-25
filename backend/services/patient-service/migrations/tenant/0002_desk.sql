-- Front desk (Phase 10): look patients up by phone / MRN / name, and remember who registered a walk-in.
ALTER TABLE patients ADD COLUMN registered_by uuid;   -- staff user id when the front desk created the record
CREATE INDEX patients_phone_idx ON patients (phone);
CREATE INDEX patients_name_idx ON patients (lower(full_name) text_pattern_ops);
