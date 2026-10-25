-- Phase 20: where patients' online payments go (Razorpay Route: a linked account per hospital; MediCare keeps a
-- platform fee). Until a hospital connects one, patients can only pay at the hospital.
CREATE TABLE payment_account (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  status text NOT NULL CHECK (status IN ('ACTIVE','SUSPENDED')),
  provider text NOT NULL CHECK (provider IN ('ROUTE_SIMULATED','RAZORPAY_ROUTE')),
  linked_account_id text NOT NULL,
  business_name text NOT NULL,
  business_type text NOT NULL,
  pan_masked text,
  bank_last4 text,
  ifsc text,
  contact_email text,
  platform_fee_percent numeric(5,2) NOT NULL DEFAULT 1.00,
  connected_by text NOT NULL,
  connected_at timestamptz NOT NULL DEFAULT now()
);

-- each captured online payment: what goes to the hospital, what MediCare keeps
CREATE TABLE transfers (
  id uuid PRIMARY KEY,
  payment_id uuid NOT NULL,
  invoice_id uuid NOT NULL REFERENCES invoices(id),
  linked_account_id text NOT NULL,
  amount numeric(12,2) NOT NULL,
  platform_fee numeric(12,2) NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING','SETTLED','REVERSED')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ON transfers (payment_id);

-- hospitals that already took online payments before this: keep them working (the template DB has no hospital yet)
INSERT INTO payment_account (status, provider, linked_account_id, business_name, business_type, connected_by)
  SELECT 'ACTIVE', 'ROUTE_SIMULATED', 'acc_sim_existing', slug, 'existing hospital', 'migration' FROM public.tenant_meta LIMIT 1;
