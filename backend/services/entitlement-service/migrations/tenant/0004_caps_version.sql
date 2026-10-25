-- The capabilities cache version lives with the data it versions: bumped in the same transaction as a role, module or
-- plan change, so a cached answer can never be keyed by a version whose change isn't committed yet.
CREATE TABLE caps_version (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  version bigint NOT NULL DEFAULT 0
);
INSERT INTO caps_version (id, version) VALUES (true, 0);
