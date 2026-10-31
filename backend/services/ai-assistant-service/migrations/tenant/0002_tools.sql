-- Phase 23: the concierge's tools (docs/AI-AGENTS.md §4.1, §8.1).

-- ACTION: the outcome of a Confirm card (booked, cancelled, moved, or why not)
ALTER TABLE messages DROP CONSTRAINT messages_kind_check;
ALTER TABLE messages ADD CONSTRAINT messages_kind_check CHECK (kind IN ('TEXT','ANSWER','EMERGENCY','BLOCKED','FALLBACK','HANDOFF','LIMIT','ACTION'));
-- the tool calls and results behind an answer, encrypted like the text (they hold names and times): fed back to the
-- model on later turns, so "the second one" still means the second time it offered
ALTER TABLE messages ADD COLUMN trace_enc bytea;

-- Confirm cards. The model can only create these; the patient's Confirm runs the real action with their own token.
CREATE TABLE pending_actions (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  message_id uuid REFERENCES messages(id),             -- the answer that shows the card
  user_id uuid NOT NULL,
  action_type text NOT NULL CHECK (action_type IN ('BOOK_APPOINTMENT','CANCEL_APPOINTMENT','RESCHEDULE_APPOINTMENT')),
  payload jsonb NOT NULL,                              -- ids only (slot, patient, appointment) and the visit reason
  card jsonb NOT NULL,                                 -- what the patient saw: {title, lines[], confirmLabel}
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','CONFIRMED','REJECTED','EXPIRED','FAILED')),
  result jsonb,                                        -- appointment number, or the error code
  expires_at timestamptz NOT NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON pending_actions (conversation_id);
CREATE INDEX ON pending_actions (message_id);

-- Every tool the model ran: for evaluation and support. Inputs are ids, dates and codes (the free-text visit reason
-- is left out); results are summarised (counts, error codes), never names.
CREATE TABLE tool_calls (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  message_id uuid REFERENCES messages(id),
  step int NOT NULL,
  tool_name text NOT NULL,
  input jsonb NOT NULL,
  result_summary jsonb,
  is_error boolean NOT NULL DEFAULT false,
  latency_ms int,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON tool_calls (conversation_id);
