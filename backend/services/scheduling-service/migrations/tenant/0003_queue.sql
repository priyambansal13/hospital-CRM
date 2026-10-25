-- Front desk and live queue (Phase 10). docs/LLD.md §5.7.

-- Walk-ins without a free slot join the queue with no slot ("squeezed in"); everything else still has one.
ALTER TABLE appointments ALTER COLUMN slot_id DROP NOT NULL;
ALTER TABLE appointments
  ADD COLUMN source text NOT NULL DEFAULT 'ONLINE' CHECK (source IN ('ONLINE','DESK','WALK_IN')),
  ADD COLUMN local_date date,                 -- the visit's date at the branch (queue day); set for every row below
  ADD COLUMN token_no int,                    -- queue number for (doctor, branch, day), given at check-in
  ADD COLUMN checked_in_at timestamptz,
  ADD COLUMN checked_in_by uuid,
  ADD COLUMN started_at timestamptz,
  ADD COLUMN completed_at timestamptz,
  ADD COLUMN no_show_at timestamptz;

UPDATE appointments a SET local_date = (a.starts_at AT TIME ZONE b.timezone)::date FROM branches b WHERE b.id = a.branch_id;
ALTER TABLE appointments ALTER COLUMN local_date SET NOT NULL;

CREATE UNIQUE INDEX one_token_per_queue ON appointments (doctor_id, branch_id, local_date, token_no) WHERE token_no IS NOT NULL;
CREATE INDEX appointments_queue_idx ON appointments (branch_id, local_date);
CREATE INDEX appointments_noshow_idx ON appointments (ends_at) WHERE status = 'CONFIRMED';

-- Per-day token counter: one atomic upsert per check-in, so concurrent check-ins never share a number.
CREATE TABLE daily_counters (
  doctor_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  day date NOT NULL,
  last_token int NOT NULL,
  PRIMARY KEY (doctor_id, branch_id, day)
);

-- local_date follows starts_at/branch automatically (every insert path, incl. reschedule's INSERT … SELECT)
CREATE FUNCTION set_appointment_local_date() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  NEW.local_date := (NEW.starts_at AT TIME ZONE (SELECT timezone FROM branches WHERE id = NEW.branch_id))::date;
  RETURN NEW;
END $$;
CREATE TRIGGER appointments_local_date BEFORE INSERT OR UPDATE OF starts_at, branch_id ON appointments
  FOR EACH ROW EXECUTE FUNCTION set_appointment_local_date();
