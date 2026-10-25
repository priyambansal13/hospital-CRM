-- Phase 19: metered features' overage rule, and the hospital's subscription status (from subscription.status_changed).
ALTER TABLE tenant_features ADD COLUMN overage text;
-- billing state lives in its own one-row table: a hospital may have a subscription before/without a contract change
CREATE TABLE tenant_billing (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  status text NOT NULL,
  seq int NOT NULL,
  trial_ends_at timestamptz,
  grace_ends_at timestamptz,
  period_end timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
