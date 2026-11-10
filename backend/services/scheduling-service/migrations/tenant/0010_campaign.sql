-- Hospital-run campaigns (docs/SEO-AND-ADS.md §4): the campaign link a patient arrived by ("google-business / noida",
-- "whatsapp / diwali-checkup"), kept with their online booking so /admin/analytics shows bookings by source. Only the
-- UTM source and campaign the hospital itself put in its link; nothing about the patient goes anywhere.
ALTER TABLE appointments ADD COLUMN campaign text CHECK (campaign ~ '^[a-z0-9 ._/+:-]{1,120}$');
