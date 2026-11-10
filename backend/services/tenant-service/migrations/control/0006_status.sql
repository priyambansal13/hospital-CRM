-- The public status page (docs/OPERATIONS.md §5): incidents and planned maintenance that MediCare support posts from
-- the console, with their updates. Component state also comes from the services' own health checks.
CREATE TABLE status_incidents (
  id uuid PRIMARY KEY,
  title text NOT NULL CHECK (length(title) BETWEEN 3 AND 160),
  impact text NOT NULL CHECK (impact IN ('MINOR','MAJOR','CRITICAL','MAINTENANCE')),
  components text[] NOT NULL CHECK (cardinality(components) > 0),
  status text NOT NULL CHECK (status IN ('SCHEDULED','INVESTIGATING','IDENTIFIED','MONITORING','RESOLVED')),
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz,
  resolved_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON status_incidents (starts_at DESC);

CREATE TABLE status_updates (
  id uuid PRIMARY KEY,
  incident_id uuid NOT NULL REFERENCES status_incidents(id) ON DELETE CASCADE,
  status text NOT NULL,
  message text NOT NULL CHECK (length(message) BETWEEN 3 AND 2000),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON status_updates (incident_id, created_at);
