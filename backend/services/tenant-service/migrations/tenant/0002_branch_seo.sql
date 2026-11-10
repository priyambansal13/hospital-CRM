-- Hospital-site SEO (docs/SEO-AND-ADS.md §2.2): the area a branch serves ("Sector 62, Noida"), used in page titles
-- and descriptions, and the web addresses a branch had before a rename, so old links and search results still reach it.
ALTER TABLE branches ADD COLUMN area text CHECK (length(area) <= 80);

CREATE TABLE branch_slugs (
  slug text PRIMARY KEY CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  retired_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON branch_slugs (branch_id);
