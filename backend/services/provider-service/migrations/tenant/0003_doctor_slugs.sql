-- Readable addresses for doctor profiles (SEO): /care/doctors/<slug>, e.g. "ananya-sharma-cardiology".
-- Unique per hospital. When a doctor's name or main specialty changes, the old slug moves to retired_slugs so old
-- links (and search engines) are sent on to the profile. New and changed doctors get theirs from DirectoryRepo.assignSlug
-- (nest-common slugify); this backfill uses the same rules for ASCII names.
ALTER TABLE doctors ADD COLUMN slug text CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

CREATE TABLE retired_slugs (
  slug text PRIMARY KEY CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  doctor_id uuid NOT NULL REFERENCES doctors (id) ON DELETE CASCADE,
  retired_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX retired_slugs_doctor ON retired_slugs (doctor_id);

WITH base AS (
  SELECT d.id, d.created_at,
         coalesce(nullif(trim(BOTH '-' FROM left(trim(BOTH '-' FROM regexp_replace(lower(replace(
           regexp_replace(d.full_name, '^\s*dr\.?\s+', '', 'i') || ' ' || coalesce((
             SELECT s.name FROM doctor_specialties ds JOIN specialties s ON s.id = ds.specialty_id
             WHERE ds.doctor_id = d.id ORDER BY ds.is_primary DESC, s.name LIMIT 1), ''),
           '&', ' and ')), '[^a-z0-9]+', '-', 'g')), 76)), ''), 'doctor') AS b
  FROM doctors d
), numbered AS (
  SELECT id, b, row_number() OVER (PARTITION BY b ORDER BY created_at, id) AS n FROM base
)
UPDATE doctors d SET slug = CASE WHEN x.n = 1 THEN x.b ELSE x.b || '-' || x.n END
FROM numbered x WHERE x.id = d.id;

CREATE UNIQUE INDEX doctors_slug_unique ON doctors (slug);
