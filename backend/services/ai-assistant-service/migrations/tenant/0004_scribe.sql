-- Phase 25: AI scribe drafts (docs/AI-AGENTS.md §5.1–5.2). Nothing enters the record until the doctor takes it over
-- into the visit notes, edits it and signs the visit; what they took over is kept (final) to measure the edits.
ALTER TABLE clinical_drafts DROP CONSTRAINT clinical_drafts_kind_check;
ALTER TABLE clinical_drafts ADD CONSTRAINT clinical_drafts_kind_check CHECK (kind IN ('PREVISIT_SUMMARY','SOAP'));
ALTER TABLE clinical_drafts DROP CONSTRAINT clinical_drafts_status_check;
ALTER TABLE clinical_drafts ADD CONSTRAINT clinical_drafts_status_check CHECK (status IN ('DRAFT','SUPERSEDED','APPLIED','DISCARDED'));
ALTER TABLE clinical_drafts ADD COLUMN encounter_id uuid;
ALTER TABLE clinical_drafts ADD COLUMN recording_id uuid;
ALTER TABLE clinical_drafts ADD COLUMN final_enc bytea;          -- what the doctor took over (after their edits)
ALTER TABLE clinical_drafts ADD COLUMN edited boolean;           -- final differs from the draft
ALTER TABLE clinical_drafts ADD COLUMN applied_at timestamptz;
CREATE INDEX ON clinical_drafts (encounter_id, created_at DESC);
