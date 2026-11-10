-- MediCare's own growth funnel (docs/SEO-AND-ADS.md §3.5): where signups and demo requests came from, the demo
-- requests themselves, and the conversions reported back to ad platforms. Only MediCare's marketing site feeds this;
-- nothing here ever comes from a hospital's patient pages.

-- where a visitor came from (UTM tags, and ad click ids only when they accepted ad cookies), stored with the signup
ALTER TABLE signups ADD COLUMN attribution jsonb NOT NULL DEFAULT '{}';
ALTER TABLE signups ADD COLUMN ads_consent boolean NOT NULL DEFAULT false;

-- "Book a demo" requests: sales follows them up on the console
CREATE TABLE leads (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL,
  phone text,
  hospital_name text NOT NULL,
  city text,
  segment text NOT NULL CHECK (segment IN ('CLINIC','DIAGNOSTIC','HOSPITAL','DENTAL','EYE','OTHER')),
  doctors int CHECK (doctors BETWEEN 0 AND 100000),
  message text,
  status text NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW','CONTACTED','DEMO_DONE','WON','LOST')),
  note text,
  attribution jsonb NOT NULL DEFAULT '{}',
  ads_consent boolean NOT NULL DEFAULT false,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);
CREATE INDEX ON leads (created_at DESC);
CREATE INDEX ON leads (email, created_at);

-- one row per funnel step reached (a lead, a confirmed signup, a hospital ready, a first payment). The e-mail is kept
-- only as a SHA-256 hash (what Google's Enhanced Conversions and Meta's Conversions API accept); only rows with ad
-- consent are ever sent or exported.
CREATE TABLE conversions (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('LEAD','SIGNUP','READY','PAID')),
  ref_id uuid NOT NULL,
  email_sha256 text NOT NULL CHECK (email_sha256 ~ '^[0-9a-f]{64}$'),
  attribution jsonb NOT NULL DEFAULT '{}',
  ads_consent boolean NOT NULL,
  value numeric(12,2),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  meta_sent_at timestamptz,
  meta_error text,
  UNIQUE (kind, ref_id)
);
CREATE INDEX ON conversions (occurred_at DESC);
CREATE INDEX conversions_meta_pending ON conversions (occurred_at) WHERE ads_consent AND meta_sent_at IS NULL;
