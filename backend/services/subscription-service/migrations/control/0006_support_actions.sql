-- Console support actions (docs/ROLE-FLOWS-AND-GAPS.md H-7): credit notes taken off the next invoice.
CREATE TABLE saas_credits (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  reason text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_invoice_id uuid,
  applied_at timestamptz
);
CREATE INDEX ON saas_credits (tenant_id) WHERE applied_invoice_id IS NULL;
