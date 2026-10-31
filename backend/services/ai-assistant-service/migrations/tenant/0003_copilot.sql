-- Phase 24: the doctor's copilot (docs/AI-AGENTS.md §5, §8.1). A draft is never part of the medical record: the
-- doctor reads it, checks the cited records, and writes their own note.
CREATE TABLE clinical_drafts (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('PREVISIT_SUMMARY')),
  appointment_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  doctor_user_id uuid NOT NULL,                        -- the staff user who asked for it
  draft_enc bytea NOT NULL,                            -- {sections: [{title, lines: [{text, refs}]}]}, encrypted
  sources jsonb NOT NULL DEFAULT '[]',                 -- what the refs point at: [{ref, type, id, date}] (ids, never text)
  dropped_lines int NOT NULL DEFAULT 0,                -- lines removed because they cited nothing real (citation check)
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SUPERSEDED')),
  model text, prompt_version text NOT NULL,
  input_tokens int, output_tokens int, latency_ms int,
  -- the doctor's feedback (quality signal)
  rating smallint CHECK (rating IN (-1, 1)),
  feedback_reason text CHECK (feedback_reason IN ('WRONG','MISSING','NOT_USEFUL','TOO_LONG','OTHER')),
  feedback_comment_enc bytea,
  feedback_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON clinical_drafts (appointment_id, created_at DESC);
CREATE INDEX ON clinical_drafts (doctor_user_id, created_at DESC);
