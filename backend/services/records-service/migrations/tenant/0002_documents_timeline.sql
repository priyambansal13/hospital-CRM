-- Documents, health timeline, consents (Phase 13). docs/LLD.md §3.6, §10, §11.

CREATE TABLE medical_documents (
  id uuid PRIMARY KEY,
  patient_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('LAB_REPORT','PRESCRIPTION','DISCHARGE','IMAGING','EXTERNAL','OTHER')),
  title text NOT NULL CHECK (length(title) BETWEEN 2 AND 200),
  source text NOT NULL CHECK (source IN ('INTERNAL','UPLOADED')),
  storage_key text NOT NULL,                   -- object key in the hospital's bucket; never a public URL
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL,
  sha256 char(64),
  -- PENDING: uploaded, waiting for the scan; SCANNING: claimed by the scan job; CLEAN: visible;
  -- INFECTED: malware found (object deleted); REJECTED: not what it claimed to be / too big (object deleted)
  scan_status text NOT NULL DEFAULT 'PENDING' CHECK (scan_status IN ('PENDING','SCANNING','CLEAN','INFECTED','REJECTED')),
  scan_detail text,
  scan_attempts int NOT NULL DEFAULT 0,
  scan_claimed_at timestamptz,
  issued_on date,                              -- date on the document (e.g. the report's date)
  related_type text, related_id uuid,
  uploaded_by uuid NOT NULL,
  uploaded_by_kind text NOT NULL CHECK (uploaded_by_kind IN ('patient','staff')),
  uploaded_by_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX ON medical_documents (patient_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX ON medical_documents (scan_status) WHERE scan_status IN ('PENDING','SCANNING');

-- One row per thing on a patient's timeline; small, non-clinical summary (details come from the owning table)
CREATE TABLE timeline_entries (
  id uuid PRIMARY KEY,
  patient_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  kind text NOT NULL CHECK (kind IN ('APPOINTMENT','ENCOUNTER','PRESCRIPTION','LAB_ORDER','REPORT','DOCUMENT')),
  ref_id uuid NOT NULL,
  title text NOT NULL,
  summary jsonb NOT NULL DEFAULT '{}',
  doctor_id uuid,
  branch_id uuid,
  UNIQUE (kind, ref_id)
);
CREATE INDEX ON timeline_entries (patient_id, occurred_at DESC, id DESC);

-- read model of patient-service consents (who the patient shared what with, until when)
CREATE TABLE consents (
  id uuid PRIMARY KEY,
  patient_id uuid NOT NULL,
  doctor_id uuid NOT NULL,
  scope text[] NOT NULL,
  valid_until timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX ON consents (doctor_id, patient_id);

-- backfill what already exists
INSERT INTO timeline_entries (id, patient_id, occurred_at, kind, ref_id, title, summary, doctor_id, branch_id)
SELECT gen_random_uuid(), e.patient_id, coalesce(e.signed_at, e.started_at), 'ENCOUNTER', e.id,
       'Visit with ' || coalesce(d.name, 'doctor'),
       jsonb_build_object('diagnosis', (SELECT description FROM diagnoses x WHERE x.encounter_id = e.id ORDER BY is_primary DESC LIMIT 1), 'status', e.status),
       e.doctor_id, e.branch_id
FROM encounters e LEFT JOIN doctors d ON d.id = e.doctor_id
WHERE e.status <> 'OPEN'
ON CONFLICT (kind, ref_id) DO NOTHING;

INSERT INTO timeline_entries (id, patient_id, occurred_at, kind, ref_id, title, summary, doctor_id)
SELECT gen_random_uuid(), p.patient_id, p.issued_at, 'PRESCRIPTION', p.id, 'Prescription ' || p.prescription_no,
       jsonb_build_object('items', (SELECT count(*) FROM prescription_items i WHERE i.prescription_id = p.id), 'doctor', d.name),
       p.doctor_id
FROM prescriptions p LEFT JOIN doctors d ON d.id = p.doctor_id
ON CONFLICT (kind, ref_id) DO NOTHING;
