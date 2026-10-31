-- integration-service control plane (schema "integration" in mc_control). Envelope encryption of webhook signing
-- secrets (same scheme as records-service, its own keys): one data key per hospital, wrapped by the master key.
CREATE TABLE tenant_keys (
  tenant_id uuid NOT NULL,
  version int NOT NULL,
  wrapped_dek bytea NOT NULL,
  kek_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, version)
);
