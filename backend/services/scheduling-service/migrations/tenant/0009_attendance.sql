-- Phase 29: no-show outreach. The evening before, bookings at high risk of a no-show (a points score on the
-- patient's history and the booking) get a "please confirm you are coming" message; the patient's tap is kept.
ALTER TABLE appointments ADD COLUMN noshow_risk smallint;
ALTER TABLE appointments ADD COLUMN outreach_sent_at timestamptz;
ALTER TABLE appointments ADD COLUMN attendance_confirmed_at timestamptz;
