-- Packaging (docs/PRODUCT-MODULES-AND-PLANS.md §3–§6, §9), control plane only: what MediCare sells and what each
-- hospital bought. Modules/features/settings themselves come from the manifests in backend/modules (developer-owned).

-- preset bundles per hospital type
CREATE TABLE editions (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z_]{3,40}$'),
  name text NOT NULL,
  description text
);

CREATE TABLE plans (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z_]{3,40}$'),
  name text NOT NULL,
  edition_id uuid NOT NULL REFERENCES editions(id),
  tier text NOT NULL,                              -- Starter / Professional / Enterprise
  sort_order int NOT NULL DEFAULT 0
);

-- a plan is changed by publishing a new version; hospitals stay on the version they bought until moved
CREATE TABLE plan_versions (
  id uuid PRIMARY KEY,
  plan_id uuid NOT NULL REFERENCES plans(id),
  version int NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('DRAFT','PUBLISHED','RETIRED')),
  list_price numeric(12,2) NOT NULL CHECK (list_price >= 0),   -- INR per month; price books replace this in Phase 19
  trial_days int NOT NULL DEFAULT 0,
  published_at timestamptz,
  UNIQUE (plan_id, version)
);

CREATE TABLE plan_version_modules (
  plan_version_id uuid NOT NULL REFERENCES plan_versions(id),
  module_key text NOT NULL,
  PRIMARY KEY (plan_version_id, module_key)
);

-- features of the included modules: a missing row = on, unlimited
CREATE TABLE plan_features (
  plan_version_id uuid NOT NULL REFERENCES plan_versions(id),
  feature_key text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  limit_value bigint CHECK (limit_value >= 0),     -- NULL = unlimited
  PRIMARY KEY (plan_version_id, feature_key)
);

-- ranges a hospital admin may pick from for plan-bounded settings
CREATE TABLE plan_setting_bounds (
  plan_version_id uuid NOT NULL REFERENCES plan_versions(id),
  setting_key text NOT NULL,
  min_value numeric, max_value numeric, allowed_values text[], locked_value jsonb,
  PRIMARY KEY (plan_version_id, setting_key)
);

-- a module, or more of a limit, bought on top of a plan
CREATE TABLE addons (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9_]{3,40}$'),
  name text NOT NULL,
  module_key text,                                 -- MODULE add-on
  feature_key text, extra_limit bigint,            -- QUOTA add-on: + extra_limit × quantity
  list_price numeric(12,2) NOT NULL CHECK (list_price >= 0),
  CHECK ((module_key IS NOT NULL) <> (feature_key IS NOT NULL AND extra_limit IS NOT NULL))
);

-- which add-ons may be bought with a plan version
CREATE TABLE plan_version_addons (
  plan_version_id uuid NOT NULL REFERENCES plan_versions(id),
  addon_id uuid NOT NULL REFERENCES addons(id),
  PRIMARY KEY (plan_version_id, addon_id)
);

-- what one hospital bought: plan version + add-ons + overrides (one ACTIVE contract per hospital; history kept)
CREATE TABLE contracts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  plan_version_id uuid NOT NULL REFERENCES plan_versions(id),
  status text NOT NULL CHECK (status IN ('ACTIVE','ENDED')),
  -- {"modules": {"emr": false}, "features": {"core.branches": {"limit": 40}}}  (sales/support exceptions)
  overrides jsonb NOT NULL DEFAULT '{}',
  starts_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  created_by text NOT NULL,
  reason text NOT NULL
);
CREATE UNIQUE INDEX contracts_one_active ON contracts (tenant_id) WHERE status = 'ACTIVE';
CREATE INDEX ON contracts (tenant_id, starts_at);

CREATE TABLE contract_addons (
  contract_id uuid NOT NULL REFERENCES contracts(id),
  addon_id uuid NOT NULL REFERENCES addons(id),
  quantity int NOT NULL DEFAULT 1 CHECK (quantity > 0),
  PRIMARY KEY (contract_id, addon_id)
);

-- per-hospital counter for ContractChanged.seq (consumers ignore older events)
CREATE TABLE tenant_seq (
  tenant_id uuid PRIMARY KEY,
  seq int NOT NULL DEFAULT 0
);
