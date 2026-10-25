-- Scheduling, in each hospital's own database (schema "scheduling"). docs/LLD.md §3.4 and §5.1.

-- Read models (written only by event consumers)
CREATE TABLE doctors (
  id uuid PRIMARY KEY,
  user_id uuid UNIQUE,
  name text NOT NULL,
  status text NOT NULL,
  branch_ids uuid[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE branches (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  timezone text NOT NULL DEFAULT 'Asia/Kolkata',
  active boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Weekly working hours: one row per (weekday, time range, branch)
CREATE TABLE availability_templates (
  id uuid PRIMARY KEY,
  doctor_id uuid NOT NULL REFERENCES doctors(id),
  branch_id uuid NOT NULL REFERENCES branches(id),
  day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),     -- ISO: Monday = 1
  start_time time NOT NULL,
  end_time time NOT NULL,
  slot_minutes smallint NOT NULL CHECK (slot_minutes IN (5,10,15,20,30,45,60)),
  mode text NOT NULL DEFAULT 'IN_PERSON' CHECK (mode IN ('IN_PERSON','VIDEO')),
  effective_from date NOT NULL,
  effective_to date,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_time > start_time),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX ON availability_templates (doctor_id, day_of_week);

-- Full-day leave (dates are local to each slot's branch)
CREATE TABLE doctor_leaves (
  id uuid PRIMARY KEY,
  doctor_id uuid NOT NULL REFERENCES doctors(id),
  from_date date NOT NULL,
  to_date date NOT NULL,
  reason text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (to_date >= from_date)
);
CREATE INDEX ON doctor_leaves (doctor_id, from_date);

-- Pre-generated bookable slots (docs/HLD.md §12: makes double booking a single-row check)
CREATE TABLE slots (
  id uuid PRIMARY KEY,
  doctor_id uuid NOT NULL REFERENCES doctors(id),
  branch_id uuid NOT NULL REFERENCES branches(id),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  mode text NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','HELD','BOOKED','BLOCKED')),
  template_id uuid REFERENCES availability_templates(id) ON DELETE SET NULL,
  held_by uuid,
  held_until timestamptz,
  version int NOT NULL DEFAULT 0,
  UNIQUE (doctor_id, starts_at)
);
CREATE INDEX slots_open_idx ON slots (doctor_id, starts_at) WHERE status = 'OPEN';
CREATE INDEX slots_template_idx ON slots (template_id);
