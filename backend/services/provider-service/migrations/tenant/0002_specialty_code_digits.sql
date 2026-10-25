-- Specialty codes may contain digits (codes are derived from names, e.g. "Sleep Medicine 2").
ALTER TABLE specialties DROP CONSTRAINT specialties_code_check;
ALTER TABLE specialties ADD CONSTRAINT specialties_code_check CHECK (code ~ '^[A-Z][A-Z0-9_]{1,39}$');
