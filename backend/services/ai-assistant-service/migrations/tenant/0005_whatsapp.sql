-- Phase 25: the concierge on WhatsApp. A phone is linked to the patient's account by the hospital's normal SMS login
-- code (iam), once per 30 days; the session it opens is kept encrypted, so every tool still runs with the patient's
-- own token. No report contents go to WhatsApp.
ALTER TABLE conversations DROP CONSTRAINT conversations_channel_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_channel_check CHECK (channel IN ('WEB','WHATSAPP'));

CREATE TABLE wa_links (
  phone text PRIMARY KEY,                 -- +9198…
  person_id uuid,                         -- set once the code was right
  refresh_enc bytea,                      -- the patient session's refresh token (rotated on every use)
  state text NOT NULL CHECK (state IN ('CODE_SENT','LINKED')),
  conversation_id uuid REFERENCES conversations(id),
  verified_until timestamptz,
  code_sent_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
