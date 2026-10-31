-- Phase 25: deterministic prescription safety and the AI scribe (docs/AI-AGENTS.md §5).

-- a major interaction (with the new items or the patient's current medicines) needs the doctor's reason
ALTER TABLE prescriptions ADD COLUMN interaction_override_reason text;

-- notes the doctor took over from an AI scribe draft (they still edit and sign them); for audit and quality review
ALTER TABLE encounters ADD COLUMN ai_assisted boolean NOT NULL DEFAULT false;
ALTER TABLE encounters ADD COLUMN ai_draft_id uuid;
-- the patient's consent to recording, per visit
ALTER TABLE encounters ADD COLUMN scribe_consent_at timestamptz;
ALTER TABLE encounters ADD COLUMN scribe_consent_by uuid;
ALTER TABLE encounters ADD COLUMN scribe_consent_method text CHECK (scribe_consent_method IN ('VERBAL','WRITTEN'));

-- consultation recordings: encrypted in the hospital's bucket, deleted when the visit is signed (or after
-- SCRIBE_AUDIO_HOURS at the latest); the row stays as the audit trail
CREATE TABLE scribe_recordings (
  id uuid PRIMARY KEY,
  encounter_id uuid NOT NULL REFERENCES encounters(id),
  object_key text NOT NULL,
  mime_type text NOT NULL,
  size_bytes int NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  delete_reason text
);
CREATE INDEX ON scribe_recordings (encounter_id);
CREATE INDEX scribe_recordings_live ON scribe_recordings (created_at) WHERE deleted_at IS NULL;
