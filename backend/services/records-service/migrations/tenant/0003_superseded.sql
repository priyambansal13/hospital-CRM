-- Phase 15: amended lab reports replace earlier versions (kept for the record, hidden from normal lists).
ALTER TABLE medical_documents ADD COLUMN superseded_by uuid REFERENCES medical_documents(id);
