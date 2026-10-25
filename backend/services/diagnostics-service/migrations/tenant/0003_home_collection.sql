-- Home sample collection (Phase 16, module home_collection): pincodes served per branch with a visit fee, home
-- collection times (same windows table, kind HOME), the visit itself and its status history, phlebotomists.

-- one branch serves each pincode; the fee is added to the order as a HOME_VISIT line
CREATE TABLE home_service_areas (
  id uuid PRIMARY KEY,
  branch_id uuid NOT NULL REFERENCES branches(id),
  pincode char(6) NOT NULL UNIQUE CHECK (pincode ~ '^[1-9][0-9]{5}$'),
  area text,                                   -- "Sector 44, Gurugram" (shown to the patient)
  fee numeric(10,2) NOT NULL DEFAULT 0 CHECK (fee >= 0),
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON home_service_areas (branch_id);

-- LAB = patients come to the branch; HOME = a phlebotomist visits (capacity = visits per time)
ALTER TABLE collection_windows ADD COLUMN kind text NOT NULL DEFAULT 'LAB' CHECK (kind IN ('LAB','HOME'));
ALTER TABLE collection_windows DROP CONSTRAINT collection_windows_branch_id_day_of_week_start_time_key;
ALTER TABLE collection_windows ADD CONSTRAINT collection_windows_kind_key UNIQUE (branch_id, kind, day_of_week, start_time);

ALTER TABLE lab_orders ADD COLUMN collection_type text NOT NULL DEFAULT 'AT_LAB' CHECK (collection_type IN ('AT_LAB','HOME'));
ALTER TABLE lab_orders ADD COLUMN home_address jsonb;   -- {line1, line2, landmark, city, pincode}
DROP INDEX lab_orders_slot_idx;
CREATE INDEX lab_orders_slot_idx ON lab_orders (branch_id, collection_type, slot_at) WHERE status IN ('PENDING_PAYMENT','BOOKED','SAMPLE_COLLECTED','IN_LAB','SAMPLE_REJECTED');

ALTER TABLE lab_order_lines DROP CONSTRAINT lab_order_lines_kind_check;
ALTER TABLE lab_order_lines ADD CONSTRAINT lab_order_lines_kind_check CHECK (kind IN ('TEST','PACKAGE','HOME_VISIT'));

-- staff who collect at home (read model from iam.staff_joined with the PHLEBOTOMIST role)
CREATE TABLE phlebotomists (
  user_id uuid PRIMARY KEY, name text NOT NULL, email text NOT NULL, active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- one visit per order; a missed visit is rescheduled on the same row (history in home_visit_log)
CREATE TABLE home_visits (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL UNIQUE REFERENCES lab_orders(id),
  branch_id uuid NOT NULL REFERENCES branches(id),
  slot_at timestamptz NOT NULL,
  local_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('UNASSIGNED','ASSIGNED','EN_ROUTE','ARRIVED','COLLECTED','HANDED_OVER','MISSED','CANCELLED')),
  phlebotomist_id uuid REFERENCES phlebotomists(user_id),
  phlebotomist_name text,
  missed_reason text,
  attempts smallint NOT NULL DEFAULT 1,
  version int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX home_visits_board_idx ON home_visits (branch_id, local_date, slot_at);
CREATE INDEX home_visits_mine_idx ON home_visits (phlebotomist_id, local_date, slot_at);
-- a phlebotomist is in one home at a time
CREATE UNIQUE INDEX home_visits_one_per_slot ON home_visits (phlebotomist_id, slot_at) WHERE status IN ('ASSIGNED','EN_ROUTE','ARRIVED');

CREATE TABLE home_visit_log (
  id uuid PRIMARY KEY, visit_id uuid NOT NULL REFERENCES home_visits(id),
  status text NOT NULL, by_user uuid, by_name text, note text, at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON home_visit_log (visit_id, at);
