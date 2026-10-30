-- Staff offboarding (docs/ROLE-FLOWS-AND-GAPS.md B-2): who deactivated whom, when and why; invite resends.
ALTER TABLE staff_members ADD COLUMN disabled_at timestamptz;
ALTER TABLE staff_members ADD COLUMN disabled_by uuid;
ALTER TABLE staff_members ADD COLUMN disabled_reason text;
ALTER TABLE staff_members ADD COLUMN invite_sent_at timestamptz;
