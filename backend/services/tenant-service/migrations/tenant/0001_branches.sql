-- Lives in every hospital's own database, schema "tenant".
CREATE TABLE branches (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  city text NOT NULL,
  address jsonb NOT NULL DEFAULT '{}',
  timezone text NOT NULL DEFAULT 'Asia/Kolkata',
  active boolean NOT NULL DEFAULT true,
  version int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX branches_name_unique ON branches (lower(name));
