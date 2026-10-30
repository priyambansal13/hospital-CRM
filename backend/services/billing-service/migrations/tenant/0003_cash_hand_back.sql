-- Refunds of counter payments (cash, the hospital's UPI QR, card machine) are handed back at the desk
-- (docs/ROLE-FLOWS-AND-GAPS.md: cash refund hand-back). They wait in HAND_BACK until someone records it.
ALTER TABLE refunds DROP CONSTRAINT refunds_status_check;
ALTER TABLE refunds ADD CONSTRAINT refunds_status_check CHECK (status IN ('PENDING','SUBMITTING','PROCESSING','HAND_BACK','PROCESSED','FAILED'));
ALTER TABLE refunds ADD COLUMN handed_back_by uuid;
ALTER TABLE refunds ADD COLUMN handed_back_method text;
CREATE INDEX refunds_hand_back ON refunds (created_at) WHERE status = 'HAND_BACK';
