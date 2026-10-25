-- Notifications, in each hospital's own database (schema "notification"). docs/LLD.md §14.

-- Read model from patient.events: who a patient record belongs to (messages go to the account holder)
CREATE TABLE recipients (
  patient_id uuid PRIMARY KEY,
  account_person_id uuid NOT NULL,
  name text NOT NULL
);
-- Contact details + preferences per signed-in person (account holder)
CREATE TABLE contacts (
  person_id uuid PRIMARY KEY,
  phone text,
  email text,
  language text NOT NULL DEFAULT 'en' CHECK (language IN ('en','hi')),
  sms_enabled boolean NOT NULL DEFAULT true,
  email_enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Message templates, editable by the hospital (seeded per hospital, versioned by updated_at)
CREATE TABLE templates (
  id uuid PRIMARY KEY,
  key text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('SMS','EMAIL')),
  language text NOT NULL,
  subject text,
  body text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (key, channel, language)
);

-- Delivery log: one row per message per channel (scheduled reminders are rows with a future send_at)
CREATE TABLE notifications (
  id uuid PRIMARY KEY,
  dedupe_key text NOT NULL UNIQUE,              -- e.g. reminder_24h:SMS:<appointment id>: re-consuming an event never doubles a message
  recipient_person_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('SMS','EMAIL')),
  template_key text NOT NULL,
  vars jsonb NOT NULL DEFAULT '{}',
  related_type text, related_id uuid,
  status text NOT NULL CHECK (status IN ('SCHEDULED','SENT','FAILED','SKIPPED','CANCELLED')),
  send_at timestamptz NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  to_address text,                              -- filled when sent (masked in the admin view)
  rendered_subject text, rendered_body text,
  last_error text,
  provider_message_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX notifications_due ON notifications (send_at) WHERE status = 'SCHEDULED';
CREATE INDEX ON notifications (related_id);
CREATE INDEX ON notifications (created_at DESC);
