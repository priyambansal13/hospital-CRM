-- ai-assistant-service control plane (schema "assistant" in mc_control). No patient data here.
-- Envelope encryption of chat text (same scheme as records-service, its own keys): one data key per hospital,
-- stored only wrapped by the master key. Deleting a hospital's rows here crypto-shreds its conversations.
CREATE TABLE tenant_keys (
  tenant_id uuid NOT NULL,
  version int NOT NULL,
  wrapped_dek bytea NOT NULL,
  kek_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, version)
);
