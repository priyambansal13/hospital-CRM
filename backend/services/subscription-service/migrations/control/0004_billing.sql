-- Phase 19: SaaS billing (hospitals pay MediCare). Price books, coupons, one subscription per hospital with its
-- lifecycle, invoices, usage counters flushed from Redis, usage alerts.

-- metered features: what happens beyond the plan's allowance
ALTER TABLE plan_features ADD COLUMN overage text CHECK (overage IN ('BLOCK','SOFT_WARN','ALLOW_BILL'));

CREATE TABLE price_books (
  code text PRIMARY KEY,
  name text NOT NULL,
  currency char(3) NOT NULL,
  gst_percent numeric(5,2) NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX price_books_one_default ON price_books (is_default) WHERE is_default;

-- per plan (all versions) or per metered feature (usage price); add-ons use their own list price
CREATE TABLE price_components (
  id bigserial PRIMARY KEY,
  price_book_code text NOT NULL REFERENCES price_books(code),
  plan_code text,
  feature_key text,
  model text NOT NULL CHECK (model IN ('FLAT','PER_SEAT','PER_BRANCH','TIERED','USAGE')),
  unit text,
  amount numeric(12,2),
  included int NOT NULL DEFAULT 0,
  tiers jsonb,
  CHECK ((plan_code IS NOT NULL) <> (feature_key IS NOT NULL))
);
CREATE INDEX ON price_components (price_book_code, plan_code);

CREATE TABLE coupons (
  code text PRIMARY KEY CHECK (code ~ '^[A-Z0-9_]{3,30}$'),
  description text NOT NULL,
  percent_off numeric(5,2) CHECK (percent_off > 0 AND percent_off <= 100),
  amount_off numeric(12,2) CHECK (amount_off > 0),
  months int CHECK (months > 0),                 -- how many invoices it applies to; NULL = every invoice
  max_redemptions int,
  redeemed int NOT NULL DEFAULT 0,
  valid_until date,
  active boolean NOT NULL DEFAULT true,
  created_by text NOT NULL DEFAULT 'seed',
  CHECK ((percent_off IS NOT NULL) <> (amount_off IS NOT NULL))
);

-- the hospital's billing state (docs/FEATURES-AND-PLANS.md §4.3); periods are calendar months
CREATE TABLE subscriptions (
  tenant_id uuid PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('TRIALING','ACTIVE','PAST_DUE','GRACE','SUSPENDED','CANCELLED','EXPIRED')),
  price_book_code text NOT NULL REFERENCES price_books(code),
  trial_ends_at timestamptz,
  trial_warned_at timestamptz,                    -- "your trial ends in 3 days" sent
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  payment_method jsonb,                           -- {kind: CARD, brand, last4, mandateId}
  coupon_code text REFERENCES coupons(code),
  coupon_invoices_left int,
  pending_change jsonb,                           -- a downgrade applied at the period end: {plan, addons, requestedBy}
  retry_count int NOT NULL DEFAULT 0,
  next_retry_at timestamptz,
  past_due_since timestamptz,
  grace_ends_at timestamptz,
  suspended_at timestamptz,
  ended_at timestamptz,
  clock_offset_s bigint NOT NULL DEFAULT 0,      -- DEV ONLY: lets tests jump to the renewal date (refused outside dev)
  version int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE SEQUENCE saas_invoice_no;
CREATE TABLE saas_invoices (
  id uuid PRIMARY KEY,
  number text NOT NULL UNIQUE,                    -- MC-2026-000001
  tenant_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('FIRST','RENEWAL','PRORATION')),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('OPEN','PAID','FAILED','VOID')),
  currency char(3) NOT NULL,
  subtotal numeric(12,2) NOT NULL,
  discount numeric(12,2) NOT NULL DEFAULT 0,
  gst numeric(12,2) NOT NULL,
  total numeric(12,2) NOT NULL,
  details jsonb NOT NULL,                         -- lines, discount label, GST %, plan, quantities
  attempts int NOT NULL DEFAULT 0,
  last_error text,
  payment_id text,
  issued_at timestamptz NOT NULL,                 -- billing-clock time
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON saas_invoices (tenant_id, issued_at DESC);

-- usage per hospital, metered feature and calendar month (Redis is the live counter; flushed here)
CREATE TABLE usage_counters (
  tenant_id uuid NOT NULL,
  feature_key text NOT NULL,
  month date NOT NULL,                            -- first day of the month
  used bigint NOT NULL,
  billed_invoice_id uuid REFERENCES saas_invoices(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, feature_key, month)
);

CREATE TABLE usage_alerts (
  tenant_id uuid NOT NULL,
  feature_key text NOT NULL,
  month date NOT NULL,
  threshold int NOT NULL CHECK (threshold IN (80, 100)),
  used bigint NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, feature_key, month, threshold)
);
