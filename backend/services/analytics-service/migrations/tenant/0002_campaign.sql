-- Bookings by the hospital's own campaign links (docs/SEO-AND-ADS.md §4): "source / campaign", no patient data.
ALTER TABLE fact_appointments ADD COLUMN campaign text;
