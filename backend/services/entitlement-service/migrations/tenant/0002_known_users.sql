-- Read model of this hospital's staff (from iam.staff_joined), so role APIs reject users of other hospitals.
CREATE TABLE known_users (
  user_id uuid PRIMARY KEY,
  email text NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO known_users (user_id, email)
  SELECT DISTINCT user_id, 'unknown@backfill' FROM user_roles ON CONFLICT DO NOTHING;
