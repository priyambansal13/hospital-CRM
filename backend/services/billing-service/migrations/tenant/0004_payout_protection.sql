-- Payout account protection (docs/ROLE-FLOWS-AND-GAPS.md B-5): every change kept, and money paid out to a NEW account
-- is held for a while (so a hijacked owner account cannot quietly redirect patients' payments).
ALTER TABLE payment_account ADD COLUMN payout_hold_until timestamptz;
ALTER TABLE transfers DROP CONSTRAINT transfers_status_check;
ALTER TABLE transfers ADD CONSTRAINT transfers_status_check CHECK (status IN ('PENDING','ON_HOLD','SETTLED','REVERSED'));
ALTER TABLE transfers ADD COLUMN release_at timestamptz;
CREATE INDEX transfers_on_hold ON transfers (release_at) WHERE status = 'ON_HOLD';
CREATE TABLE payment_account_history (
  id uuid PRIMARY KEY,
  changed_at timestamptz NOT NULL DEFAULT now(),
  changed_by text NOT NULL,
  change text NOT NULL CHECK (change IN ('CONNECTED','REPLACED')),
  bank_last4 text, ifsc text, prev_bank_last4 text, prev_ifsc text,
  hold_until timestamptz
);
