-- Phase 15: messages to hospital staff (e.g. a critical lab value for the ordering doctor). Their address is
-- looked up in iam-service at send time (not stored in a read model); staff get email only.
ALTER TABLE notifications ADD COLUMN recipient_kind text NOT NULL DEFAULT 'patient' CHECK (recipient_kind IN ('patient','staff'));
