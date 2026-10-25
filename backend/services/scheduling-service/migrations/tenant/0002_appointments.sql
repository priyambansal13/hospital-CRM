-- Appointments and waitlist (docs/LLD.md §3.4, §5.2–5.6).
ALTER TABLE doctors ADD COLUMN branch_fees jsonb NOT NULL DEFAULT '[]';   -- [{branchId, fee, followupFee}] from provider events

CREATE SEQUENCE appointment_seq START 1;

CREATE TABLE appointments (
  id uuid PRIMARY KEY,
  appointment_no text NOT NULL UNIQUE,                 -- APT-2026-000123
  slot_id uuid NOT NULL REFERENCES slots(id),
  patient_id uuid NOT NULL,                            -- patient-service id (no FK across services)
  patient_name text NOT NULL,                          -- snapshot at booking
  patient_mrn text NOT NULL,
  account_person_id uuid NOT NULL,                     -- signed-in person who manages the patient (ownership checks)
  booked_by uuid NOT NULL,                             -- actor who booked (patient person or staff user)
  doctor_id uuid NOT NULL REFERENCES doctors(id),
  branch_id uuid NOT NULL REFERENCES branches(id),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  mode text NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING_PAYMENT','CONFIRMED','CHECKED_IN','IN_PROGRESS','COMPLETED','CANCELLED','EXPIRED','NO_SHOW','RESCHEDULED')),
  reason text,
  fee numeric(10,2),
  payment_mode text NOT NULL DEFAULT 'AT_CLINIC' CHECK (payment_mode IN ('ONLINE','AT_CLINIC')),
  rescheduled_from uuid REFERENCES appointments(id),
  reschedule_count smallint NOT NULL DEFAULT 0,
  cancel_reason text,
  cancelled_by uuid,
  cancelled_at timestamptz,
  version int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- The real double-booking guard: at most one live appointment per slot.
CREATE UNIQUE INDEX one_active_appt_per_slot ON appointments (slot_id)
  WHERE status IN ('PENDING_PAYMENT','CONFIRMED','CHECKED_IN','IN_PROGRESS','COMPLETED');
CREATE INDEX ON appointments (patient_id, starts_at DESC);
CREATE INDEX ON appointments (account_person_id, starts_at DESC);
CREATE INDEX ON appointments (doctor_id, starts_at);

CREATE TABLE waitlist (
  id uuid PRIMARY KEY,
  patient_id uuid NOT NULL,
  patient_name text NOT NULL,
  account_person_id uuid NOT NULL,
  doctor_id uuid NOT NULL REFERENCES doctors(id),
  date date NOT NULL,                                  -- local date at the doctor's branch
  created_at timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz,
  UNIQUE (patient_id, doctor_id, date)
);
CREATE INDEX ON waitlist (doctor_id, date) WHERE notified_at IS NULL;
