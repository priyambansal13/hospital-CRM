-- Phase 27: the hospital's custom fields (definitions in integration-service) and tags added by workflow rules
ALTER TABLE patients ADD COLUMN custom_fields jsonb NOT NULL DEFAULT '{}';
ALTER TABLE patients ADD COLUMN tags text[] NOT NULL DEFAULT '{}';
