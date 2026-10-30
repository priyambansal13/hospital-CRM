-- Offboarding (docs/ROLE-FLOWS-AND-GAPS.md H-1): when a hospital was deleted, and when its data was destroyed
-- (purged after the retention period: database dropped, documents deleted, data keys destroyed).
ALTER TABLE tenants ADD COLUMN deleted_at timestamptz;
ALTER TABLE tenants ADD COLUMN purged_at timestamptz;
UPDATE tenants SET deleted_at = updated_at WHERE status = 'DELETED';
