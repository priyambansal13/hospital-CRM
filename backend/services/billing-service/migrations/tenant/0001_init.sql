-- Billing, in each hospital's own database (schema "billing"). docs/LLD.md §3.7.
CREATE SEQUENCE invoice_seq START 1;

CREATE TABLE invoices (
  id uuid PRIMARY KEY,
  invoice_no text NOT NULL UNIQUE,                       -- INV-2026-000123
  source_type text NOT NULL CHECK (source_type IN ('APPOINTMENT','LAB_ORDER')),
  source_id uuid NOT NULL,                               -- e.g. scheduling appointment id (moves on reschedule)
  patient_id uuid NOT NULL,
  patient_name text NOT NULL,
  patient_mrn text NOT NULL,
  account_person_id uuid NOT NULL,                       -- who may see/pay it (the patient's account)
  branch_id uuid NOT NULL,
  branch_name text NOT NULL,
  description text NOT NULL,
  subtotal numeric(10,2) NOT NULL CHECK (subtotal >= 0),
  discount numeric(10,2) NOT NULL DEFAULT 0,
  tax numeric(10,2) NOT NULL DEFAULT 0,                  -- GST invoices come later; consultations are exempt
  total numeric(10,2) NOT NULL CHECK (total >= 0),
  currency char(3) NOT NULL DEFAULT 'INR',
  payment_mode text NOT NULL CHECK (payment_mode IN ('ONLINE','AT_CLINIC')),
  status text NOT NULL CHECK (status IN ('ISSUED','PAID','PARTIALLY_REFUNDED','REFUNDED','VOID')),
  amount_paid numeric(10,2) NOT NULL DEFAULT 0,
  amount_refunded numeric(10,2) NOT NULL DEFAULT 0,
  pay_by timestamptz,                                    -- online: when the slot hold ends
  issued_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  voided_at timestamptz,
  void_reason text,
  version int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_type, source_id),
  CHECK (amount_refunded <= amount_paid)
);
CREATE INDEX ON invoices (account_person_id, issued_at DESC);
CREATE INDEX ON invoices (issued_at DESC);
CREATE INDEX ON invoices (status);

CREATE TABLE payments (
  id uuid PRIMARY KEY,
  invoice_id uuid NOT NULL REFERENCES invoices(id),
  channel text NOT NULL CHECK (channel IN ('ONLINE','COUNTER')),
  gateway text NOT NULL CHECK (gateway IN ('RAZORPAY','SIMULATED','COUNTER')),
  gateway_order_id text UNIQUE,
  gateway_payment_id text UNIQUE,
  amount numeric(10,2) NOT NULL CHECK (amount > 0),
  method text,                                           -- upi, card, netbanking, wallet / CASH, UPI, CARD at the counter
  reference text,                                        -- counter: UPI ref / card slip no.
  status text NOT NULL CHECK (status IN ('CREATED','CAPTURED','FAILED')),
  last_error text,
  collected_by uuid,                                     -- counter: staff user
  created_at timestamptz NOT NULL DEFAULT now(),
  captured_at timestamptz
);
CREATE INDEX ON payments (invoice_id);
-- an invoice is paid by one capture; a second one (paid twice, or after the slot was lost) is recorded, then refunded

CREATE TABLE refunds (
  id uuid PRIMARY KEY,
  invoice_id uuid NOT NULL REFERENCES invoices(id),
  payment_id uuid NOT NULL REFERENCES payments(id),
  amount numeric(10,2) NOT NULL CHECK (amount > 0),
  reason text NOT NULL,
  -- PENDING: to submit; SUBMITTING: sent to the gateway (crash-safe: re-checked before resubmitting);
  -- PROCESSING: gateway accepted, money on its way; PROCESSED: done; FAILED: needs a human
  status text NOT NULL CHECK (status IN ('PENDING','SUBMITTING','PROCESSING','PROCESSED','FAILED')),
  gateway_refund_id text UNIQUE,
  attempts int NOT NULL DEFAULT 0,
  last_error text,
  dedupe_key text UNIQUE,                                -- one refund per cause (e.g. cancel:<appointment id>)
  requested_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX ON refunds (status) WHERE status IN ('PENDING','SUBMITTING');

-- webhook retries from the gateway are processed once
CREATE TABLE processed_webhooks (
  event_id text PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now()
);
