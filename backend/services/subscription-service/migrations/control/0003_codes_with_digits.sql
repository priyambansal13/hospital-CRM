-- Plan and edition codes may contain digits (CLINIC_2027, DIAG_PRO_V2), as the console API already allows.
ALTER TABLE plans DROP CONSTRAINT plans_code_check;
ALTER TABLE plans ADD CONSTRAINT plans_code_check CHECK (code ~ '^[A-Z][A-Z0-9_]{2,39}$');
ALTER TABLE editions DROP CONSTRAINT editions_code_check;
ALTER TABLE editions ADD CONSTRAINT editions_code_check CHECK (code ~ '^[A-Z][A-Z0-9_]{2,39}$');
