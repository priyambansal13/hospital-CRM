-- Doctors' morning agenda (docs/ROLE-FLOWS-AND-GAPS.md 4.G): sent once per doctor per local day.
CREATE TABLE agenda_sent (
  doctor_id uuid NOT NULL,
  day date NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (doctor_id, day)
);
