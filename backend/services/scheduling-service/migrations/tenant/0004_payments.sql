-- Online payments (Phase 11). docs/LLD.md §4.1, §5.2–5.5.
-- An online booking HOLDS the slot (slots.status = 'HELD') and the appointment waits in PENDING_PAYMENT until
-- billing reports the payment; the hold expires after a few minutes otherwise.
ALTER TABLE appointments
  ADD COLUMN payment_status text NOT NULL DEFAULT 'UNPAID'
    CHECK (payment_status IN ('NOT_DUE','UNPAID','PAID','PARTIALLY_REFUNDED','REFUNDED')),
  ADD COLUMN invoice_id uuid,                 -- billing-service invoice (no FK across services)
  ADD COLUMN paid_at timestamptz,
  ADD COLUMN hold_expires_at timestamptz;     -- PENDING_PAYMENT only

UPDATE appointments SET payment_status = 'NOT_DUE' WHERE fee IS NULL OR fee = 0;

CREATE INDEX appointments_hold_idx ON appointments (hold_expires_at) WHERE status = 'PENDING_PAYMENT';
CREATE INDEX appointments_invoice_idx ON appointments (invoice_id);
