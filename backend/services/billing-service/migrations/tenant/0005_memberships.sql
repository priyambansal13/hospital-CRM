-- Phase 26: patient memberships. Each hospital's own tiers; a membership belongs to an account (the phone owner) and
-- covers the family members on it. Bought with an online invoice (source MEMBERSHIP), active once it is paid.
CREATE TABLE membership_plans (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z][A-Z0-9_]{1,30}$'),
  name text NOT NULL,
  description text,
  price numeric(12,2) NOT NULL CHECK (price > 0),
  period text NOT NULL CHECK (period IN ('MONTHLY','YEARLY')),
  benefits jsonb NOT NULL,
  active boolean NOT NULL DEFAULT true,
  sort smallint NOT NULL DEFAULT 0,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  id uuid PRIMARY KEY,
  account_person_id uuid NOT NULL,
  patient_id uuid NOT NULL,                 -- the account holder's own record (the invoice is in their name)
  patient_name text NOT NULL,
  plan_id uuid NOT NULL REFERENCES membership_plans(id),
  plan_snapshot jsonb NOT NULL,             -- name, price, period and benefits as bought (later edits do not change it)
  status text NOT NULL CHECK (status IN ('PENDING','ACTIVE','EXPIRED','CANCELLED')),
  starts_at timestamptz,
  ends_at timestamptz,
  invoice_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON memberships (account_person_id, status);
CREATE INDEX memberships_live ON memberships (ends_at) WHERE status = 'ACTIVE';

-- invoices for memberships: not tied to a branch
ALTER TABLE invoices DROP CONSTRAINT invoices_source_type_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_source_type_check CHECK (source_type IN ('APPOINTMENT','LAB_ORDER','MEMBERSHIP'));
ALTER TABLE invoices ALTER COLUMN branch_id DROP NOT NULL;
ALTER TABLE invoices ALTER COLUMN branch_name DROP NOT NULL;
ALTER TABLE invoices ADD CONSTRAINT invoices_branch_required CHECK (source_type = 'MEMBERSHIP' OR branch_id IS NOT NULL);
