-- search-service, in each hospital's own database (schema "search"). The documents live in OpenSearch; this only
-- records what was last indexed, so a rebuild can be seen and the status page can say how fresh the index is.
CREATE TABLE index_state (
  kind text PRIMARY KEY CHECK (kind IN ('doctors','tests')),
  version text NOT NULL,
  documents int NOT NULL DEFAULT 0,
  built_at timestamptz NOT NULL DEFAULT now(),
  refreshed_at timestamptz NOT NULL DEFAULT now()
);
