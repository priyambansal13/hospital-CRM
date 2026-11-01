-- Phase 29: the hospital's analytics warehouse (schema "analytics", in its own database), fed by domain events and a
-- one-time backfill from the owning services. De-identified: no names, MRNs, phone numbers or clinical values; a
-- patient is a keyed hash (patient_key) that only links rows inside this hospital's warehouse.

CREATE TABLE settings (
  key text PRIMARY KEY,
  value text NOT NULL
);

CREATE TABLE dim_branches (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  timezone text NOT NULL DEFAULT 'Asia/Kolkata',
  active boolean NOT NULL DEFAULT true
);

-- doctors are staff, not patients: names are kept so reports can say who
CREATE TABLE dim_doctors (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  specialty_codes text[] NOT NULL DEFAULT '{}',
  branch_ids uuid[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'ACTIVE'
);

CREATE TABLE dim_specialties (
  code text PRIMARY KEY,
  name text NOT NULL
);

-- one row per appointment, its latest state (event_at keeps an older event from overwriting a newer one)
CREATE TABLE fact_appointments (
  appointment_id uuid PRIMARY KEY,
  patient_key text NOT NULL,
  doctor_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  specialty_code text,
  local_date date NOT NULL,
  hour smallint NOT NULL,
  starts_at timestamptz NOT NULL,
  mode text,
  source text,
  booked_via text,
  payment_mode text,
  status text NOT NULL,
  fee numeric(10,2),
  booked_at timestamptz NOT NULL,
  lead_days int NOT NULL DEFAULT 0,
  first_visit boolean NOT NULL DEFAULT false,
  event_at timestamptz NOT NULL
);
CREATE INDEX fact_appointments_date ON fact_appointments (local_date);
CREATE INDEX fact_appointments_patient ON fact_appointments (patient_key, starts_at);

CREATE TABLE fact_lab_orders (
  order_id uuid PRIMARY KEY,
  patient_key text NOT NULL,
  branch_id uuid,
  status text NOT NULL,
  total numeric(10,2) NOT NULL DEFAULT 0,
  collection_type text,
  test_count int NOT NULL DEFAULT 0,
  local_date date NOT NULL,
  ordered_at timestamptz NOT NULL,
  collected_at timestamptz,
  in_lab_at timestamptz,
  published_at timestamptz,
  tat_breached boolean NOT NULL DEFAULT false,
  abnormal_count int NOT NULL DEFAULT 0,
  critical_count int NOT NULL DEFAULT 0,
  event_at timestamptz NOT NULL
);
CREATE INDEX fact_lab_orders_date ON fact_lab_orders (local_date);

-- money in (payments) and out (refunds, negative), by the day it moved
CREATE TABLE fact_payments (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('PAYMENT','REFUND')),
  invoice_id uuid NOT NULL,
  source_type text NOT NULL,
  source_id uuid NOT NULL,
  branch_id uuid,
  amount numeric(12,2) NOT NULL,
  channel text,
  method text,
  at timestamptz NOT NULL,
  local_date date NOT NULL
);
CREATE INDEX fact_payments_date ON fact_payments (local_date);

CREATE TABLE fact_patients (
  patient_key text PRIMARY KEY,
  registered_at timestamptz NOT NULL,
  local_date date NOT NULL,
  age_band text,
  gender text
);

-- bookable time per doctor, branch and day (pulled from scheduling; slots are not events)
CREATE TABLE fact_capacity (
  doctor_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  local_date date NOT NULL,
  slots int NOT NULL,
  booked int NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (doctor_id, branch_id, local_date)
);

-- payments that arrived but could not be applied (slot or order gone): the daily brief lists them
CREATE TABLE fact_payment_issues (
  id text PRIMARY KEY,
  kind text NOT NULL,
  branch_id uuid,
  at timestamptz NOT NULL
);

-- backfill progress per source (the event consumers run from the start; this covers what came before)
CREATE TABLE loads (
  source text PRIMARY KEY,
  status text NOT NULL,
  rows int NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  error text
);
