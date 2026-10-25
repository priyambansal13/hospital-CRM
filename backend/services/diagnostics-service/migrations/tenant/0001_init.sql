-- Diagnostics (lab), in each hospital's own database (schema "diagnostics"). docs/LLD.md §3.5, §4.2, §6.5.

CREATE TABLE branches (id uuid PRIMARY KEY, name text NOT NULL, timezone text NOT NULL DEFAULT 'Asia/Kolkata', active boolean NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());

-- catalog (seeded from a template per hospital, then the hospital's own)
CREATE TABLE lab_tests (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE,                  -- CBC, HBA1C …
  loinc_code text,
  name text NOT NULL,
  aliases text[] NOT NULL DEFAULT '{}',       -- "sugar test" → FBS
  category text NOT NULL,                     -- Haematology, Biochemistry …
  sample_type text NOT NULL CHECK (sample_type IN ('BLOOD','URINE','STOOL','SWAB','NONE')),
  container text,                             -- EDTA (lavender), serum (yellow), fluoride (grey) …
  preparation text,                           -- "10–12 hours fasting"
  fasting_hours smallint,
  turnaround_hours smallint NOT NULL DEFAULT 24,
  price numeric(10,2) NOT NULL CHECK (price >= 0),
  reference_ranges jsonb NOT NULL DEFAULT '[]', -- [{param, unit, low, high, sex?, ageFrom?, ageTo?, criticalLow?, criticalHigh?}] (Phase 15)
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lab_tests_name_idx ON lab_tests (lower(name));

CREATE TABLE lab_packages (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  price numeric(10,2) NOT NULL CHECK (price >= 0),
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE package_tests (
  package_id uuid NOT NULL REFERENCES lab_packages(id),
  test_id uuid NOT NULL REFERENCES lab_tests(id),
  PRIMARY KEY (package_id, test_id)
);

-- when the lab collects samples at each branch, and how many patients per slot
CREATE TABLE collection_windows (
  id uuid PRIMARY KEY,
  branch_id uuid NOT NULL REFERENCES branches(id),
  day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
  start_time time NOT NULL,
  end_time time NOT NULL,
  slot_minutes smallint NOT NULL DEFAULT 15 CHECK (slot_minutes IN (10,15,20,30,60)),
  capacity smallint NOT NULL DEFAULT 3 CHECK (capacity BETWEEN 1 AND 50),
  CHECK (end_time > start_time),
  UNIQUE (branch_id, day_of_week, start_time)
);

CREATE SEQUENCE lab_order_seq START 1;
CREATE SEQUENCE sample_seq START 1;

CREATE TABLE lab_orders (
  id uuid PRIMARY KEY,
  order_no text NOT NULL UNIQUE,                  -- LAB-2026-000123
  patient_id uuid NOT NULL,
  patient_name text NOT NULL, patient_mrn text NOT NULL, patient_dob date, patient_gender text,
  account_person_id uuid NOT NULL,
  ordered_by_doctor_id uuid,                      -- NULL: the patient booked it themselves
  ordered_by_name text,
  encounter_id uuid,
  branch_id uuid REFERENCES branches(id),
  slot_at timestamptz,                            -- collection time at the lab
  local_date date,
  status text NOT NULL CHECK (status IN ('AWAITING_BOOKING','PENDING_PAYMENT','BOOKED','SAMPLE_COLLECTED','IN_LAB','SAMPLE_REJECTED','CANCELLED','EXPIRED')),
  payment_mode text CHECK (payment_mode IN ('ONLINE','AT_CLINIC')),
  payment_status text NOT NULL DEFAULT 'UNPAID' CHECK (payment_status IN ('NOT_DUE','UNPAID','PAID','PARTIALLY_REFUNDED','REFUNDED')),
  invoice_id uuid,
  total numeric(10,2) NOT NULL DEFAULT 0,
  hold_expires_at timestamptz,
  note text,                                      -- doctor's note to the lab (no diagnosis in messages)
  cancel_reason text, cancelled_at timestamptz,
  booked_by uuid,
  version int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON lab_orders (account_person_id, created_at DESC);
CREATE INDEX ON lab_orders (patient_id, created_at DESC);
CREATE INDEX lab_orders_worklist_idx ON lab_orders (branch_id, local_date, slot_at);
CREATE INDEX lab_orders_slot_idx ON lab_orders (branch_id, slot_at) WHERE status IN ('PENDING_PAYMENT','BOOKED','SAMPLE_COLLECTED','IN_LAB','SAMPLE_REJECTED');
CREATE INDEX lab_orders_hold_idx ON lab_orders (hold_expires_at) WHERE status = 'PENDING_PAYMENT';

-- what was bought: a package or a single test, at its price at the time
CREATE TABLE lab_order_lines (
  id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES lab_orders(id),
  kind text NOT NULL CHECK (kind IN ('TEST','PACKAGE')), ref_id uuid NOT NULL, code text NOT NULL, name text NOT NULL, price numeric(10,2) NOT NULL
);
-- each test to run (a package expands into its tests); results attach here in Phase 15
CREATE TABLE lab_order_items (
  id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES lab_orders(id), line_id uuid NOT NULL REFERENCES lab_order_lines(id),
  test_id uuid NOT NULL, test_code text NOT NULL, test_name text NOT NULL, sample_type text NOT NULL,
  status text NOT NULL DEFAULT 'ORDERED'
);
CREATE INDEX ON lab_order_items (order_id);

-- one tube/container per sample type per order; barcode printed on the label and scanned at collection
CREATE TABLE samples (
  id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES lab_orders(id),
  barcode text NOT NULL UNIQUE, sample_type text NOT NULL, container text,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','COLLECTED','RECEIVED','REJECTED')),
  collected_by uuid, collected_by_name text, collected_at timestamptz,
  received_at timestamptz, rejected_reason text, replaces uuid REFERENCES samples(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON samples (order_id);
