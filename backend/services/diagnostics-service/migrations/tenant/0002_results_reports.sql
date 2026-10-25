-- Results, verification and reports (Phase 15). docs/LLD.md §3.5, §4.2, §10.2.
ALTER TABLE lab_orders DROP CONSTRAINT lab_orders_status_check;
ALTER TABLE lab_orders ADD CONSTRAINT lab_orders_status_check CHECK (status IN
  ('AWAITING_BOOKING','PENDING_PAYMENT','BOOKED','SAMPLE_COLLECTED','IN_LAB','SAMPLE_REJECTED','RESULTS_ENTERED','REPORT_PUBLISHED','CANCELLED','EXPIRED'));
ALTER TABLE lab_orders
  ADD COLUMN collected_at timestamptz,          -- first tube collected: turnaround clock starts
  ADD COLUMN due_at timestamptz,                -- collected_at + longest turnaround of its tests
  ADD COLUMN tat_breached_at timestamptz;
CREATE INDEX lab_orders_due_idx ON lab_orders (due_at) WHERE status IN ('SAMPLE_COLLECTED','IN_LAB','RESULTS_ENTERED') AND tat_breached_at IS NULL;

-- one row per reported parameter (a test may have several: CBC → haemoglobin, WBC, platelets)
CREATE TABLE lab_results (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES lab_orders(id),
  item_id uuid NOT NULL REFERENCES lab_order_items(id),
  parameter text NOT NULL,
  value text NOT NULL,
  value_num numeric,
  unit text,
  ref_low numeric, ref_high numeric,
  flag text NOT NULL CHECK (flag IN ('NORMAL','LOW','HIGH','CRITICAL_LOW','CRITICAL_HIGH','ABNORMAL')),
  entered_by uuid NOT NULL, entered_by_name text, entered_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (item_id, parameter)
);
CREATE INDEX ON lab_results (order_id);
-- previous values when a result is corrected (before or after verification)
CREATE TABLE lab_result_history (
  id uuid PRIMARY KEY, result_id uuid NOT NULL REFERENCES lab_results(id), value text NOT NULL, flag text NOT NULL,
  changed_by uuid NOT NULL, changed_by_name text, changed_at timestamptz NOT NULL DEFAULT now(), reason text
);

-- each published version of an order's report (an amendment adds a version; earlier ones stay)
CREATE TABLE lab_reports (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES lab_orders(id),
  version int NOT NULL,
  verify_code text NOT NULL UNIQUE,             -- in the QR code: anyone can check the report is genuine
  document_id uuid,                             -- records-service document (patient's record)
  pdf bytea NOT NULL,                           -- the lab keeps its copy
  sha256 char(64) NOT NULL,
  abnormal_count int NOT NULL, critical_count int NOT NULL,
  verified_by uuid NOT NULL, verified_by_name text, verified_at timestamptz NOT NULL DEFAULT now(),
  amendment_reason text,
  superseded_by uuid REFERENCES lab_reports(id),
  UNIQUE (order_id, version)
);

-- critical values: the ordering doctor (or, for self-booked tests, the pathologist) must acknowledge
CREATE TABLE critical_alerts (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES lab_orders(id),
  result_id uuid NOT NULL REFERENCES lab_results(id),
  notify_user_id uuid,                          -- ordering doctor's login; NULL → lab/pathologist
  created_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz, acknowledged_by uuid, acknowledged_by_name text,
  UNIQUE (result_id)
);
CREATE INDEX ON critical_alerts (notify_user_id) WHERE acknowledged_at IS NULL;
