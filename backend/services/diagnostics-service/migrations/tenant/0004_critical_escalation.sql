-- Critical values that nobody acknowledges escalate (docs/ROLE-FLOWS-AND-GAPS.md C-2): the ordering doctor first, then
-- the branch's pathologists, then whoever is on call at the branch. The lab records whom it phoned and that the value
-- was read back ("communicated"), which also stops the escalation.
ALTER TABLE critical_alerts ADD COLUMN level int NOT NULL DEFAULT 0;
ALTER TABLE critical_alerts ADD COLUMN escalate_at timestamptz;
ALTER TABLE critical_alerts ADD COLUMN communicated_to text;
ALTER TABLE critical_alerts ADD COLUMN read_back boolean;
ALTER TABLE critical_alerts ADD COLUMN communicated_at timestamptz;
ALTER TABLE critical_alerts ADD COLUMN communicated_by uuid;
ALTER TABLE critical_alerts ADD COLUMN communicated_by_name text;
UPDATE critical_alerts SET escalate_at = created_at + interval '15 minutes' WHERE acknowledged_at IS NULL;
CREATE INDEX critical_alerts_escalate ON critical_alerts (escalate_at) WHERE acknowledged_at IS NULL AND communicated_at IS NULL;
