-- Wave 4 (docs/ROLE-FLOWS-AND-GAPS.md A-1, B-6): cards are entered on the payment gateway's own page, never in
-- MediCare's apps. A card session is one trip to that page and back.
CREATE TABLE card_sessions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  gateway text NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING','DONE','FAILED')),
  created_by text NOT NULL,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz
);
CREATE INDEX ON card_sessions (tenant_id, created_at DESC);
-- the simulated gateway's own record of what was authorised on its page (local development only; a real gateway keeps
-- this on its side). Only the brand, last 4 digits and the mandate id: never the card number.
CREATE TABLE sim_mandates (
  session_id uuid PRIMARY KEY,
  mandate jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
