-- records-service control plane (schema "records" in mc_control). No patient data here.

-- Envelope encryption: one data key per hospital, stored only WRAPPED by the master key (KMS in the cloud,
-- MC_MASTER_KEY locally). Destroying a hospital's rows here crypto-shreds its clinical text.
CREATE TABLE tenant_keys (
  tenant_id uuid NOT NULL,
  version int NOT NULL,
  wrapped_dek bytea NOT NULL,
  kek_id text NOT NULL,                 -- which master key wrapped it
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, version)
);

-- ICD-10 reference list (shared by every hospital; a curated common subset, full list importable later)
CREATE TABLE icd10_codes (
  code text PRIMARY KEY,
  title text NOT NULL
);
CREATE INDEX icd10_title_idx ON icd10_codes (lower(title) text_pattern_ops);
