-- Phase 18: the plan builder (drafts → two-person approval → published), internal plans, platform audit log.
--   DRAFT → (submit) PENDING → (approve by someone else) PUBLISHED;  PENDING → (reject) DRAFT;  PUBLISHED → RETIRED
-- A published version is never edited: changes are a new version. Hospitals stay on their version until moved.
ALTER TABLE plan_versions DROP CONSTRAINT plan_versions_status_check;
ALTER TABLE plan_versions ADD CONSTRAINT plan_versions_status_check CHECK (status IN ('DRAFT','PENDING','PUBLISHED','RETIRED'));
ALTER TABLE plan_versions ADD COLUMN created_by text NOT NULL DEFAULT 'seed';
ALTER TABLE plan_versions ADD COLUMN updated_by text;
ALTER TABLE plan_versions ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE plan_versions ADD COLUMN submitted_by text;
ALTER TABLE plan_versions ADD COLUMN submitted_at timestamptz;
ALTER TABLE plan_versions ADD COLUMN approved_by text;
ALTER TABLE plan_versions ADD COLUMN review_note text;
-- what happens to hospitals on older versions when this one is published: NEW_ONLY (default) or MIGRATE_NOW
ALTER TABLE plan_versions ADD COLUMN migration text CHECK (migration IN ('NEW_ONLY','MIGRATE_NOW'));
ALTER TABLE plan_versions ADD COLUMN retired_at timestamptz;
-- at most one draft/pending version per plan at a time
CREATE UNIQUE INDEX plan_versions_one_open ON plan_versions (plan_id) WHERE status IN ('DRAFT','PENDING');
-- seeded versions count as approved by the seed
UPDATE plan_versions SET approved_by = 'seed' WHERE status = 'PUBLISHED' AND approved_by IS NULL;

-- MediCare's own plan(s): never listed, sold or offered as an upsell
ALTER TABLE plans ADD COLUMN internal boolean NOT NULL DEFAULT false;
ALTER TABLE plans ADD COLUMN description text;
ALTER TABLE plans ADD COLUMN created_by text NOT NULL DEFAULT 'seed';

-- every packaging and contract change, with before/after (docs/PRODUCT-MODULES-AND-PLANS.md §11: "all changes are audited")
CREATE TABLE platform_audit (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL,                -- e-mail of the MediCare user, or 'mc cli' / 'system' / 'signup'
  action text NOT NULL,               -- PLAN_CREATED, VERSION_SAVED, VERSION_SUBMITTED, VERSION_APPROVED, CONTRACT_CHANGED, …
  target_type text NOT NULL,          -- PLAN | PLAN_VERSION | EDITION | TENANT
  target_id text NOT NULL,
  target_label text,
  before jsonb,
  after jsonb,
  note text
);
CREATE INDEX ON platform_audit (at DESC);
CREATE INDEX ON platform_audit (target_type, target_id, at DESC);
