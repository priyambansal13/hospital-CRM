-- Phase 29: the Ops agent (admins' questions over the analytics semantic layer), the morning brief per branch, and
-- care-gap reminders (rules pick who; the wording is drafted through Batch Mode and approved by a person once).

-- questions to the Ops agent (no patient data exists in the answers: the warehouse is de-identified)
CREATE TABLE ops_questions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  question text NOT NULL,
  answer text NOT NULL,
  tables jsonb NOT NULL DEFAULT '[]',
  calls jsonb NOT NULL DEFAULT '[]',
  verified boolean NOT NULL,              -- every number in the model's answer came from the tool results
  model text NOT NULL,
  tokens_in int NOT NULL DEFAULT 0,
  tokens_out int NOT NULL DEFAULT 0,
  rating smallint CHECK (rating IN (-1, 1)),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ops_questions_user ON ops_questions (user_id, created_at DESC);

CREATE TABLE ops_briefs (
  id uuid PRIMARY KEY,
  branch_id uuid NOT NULL,
  branch_name text NOT NULL,
  day date NOT NULL,
  headline text NOT NULL,
  points jsonb NOT NULL,
  facts jsonb NOT NULL,
  verified boolean NOT NULL,
  model text NOT NULL,
  emailed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (branch_id, day)
);

-- the wording per care-gap rule: DRAFT (from the model or the fallback) until a person approves it
CREATE TABLE care_gap_messages (
  rule text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('DRAFTING','DRAFT','APPROVED','OFF')),
  subject text,
  body text,
  source text CHECK (source IN ('AI','TEMPLATE','EDITED')),
  note text,
  model text,
  approved_by uuid,
  approved_at timestamptz,
  version int NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE care_gap_nudges (
  id uuid PRIMARY KEY,
  rule text NOT NULL,
  patient_id uuid NOT NULL,
  account_person_id uuid NOT NULL,
  run_id uuid NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX care_gap_nudges_patient ON care_gap_nudges (rule, patient_id, sent_at DESC);

CREATE TABLE care_gap_runs (
  id uuid PRIMARY KEY,
  rule text NOT NULL,
  candidates int NOT NULL,
  nudged int NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now()
);

-- Batch Mode jobs this hospital is waiting for (polled every minute)
CREATE TABLE batch_jobs (
  id uuid PRIMARY KEY,
  kind text NOT NULL,
  provider_job text NOT NULL,
  items jsonb NOT NULL,                   -- what each request in order was for (e.g. rule keys)
  status text NOT NULL CHECK (status IN ('PENDING','DONE','FAILED')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
