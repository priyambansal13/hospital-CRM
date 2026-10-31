-- Phase 23: appointments booked through the AI assistant's Confirm card (the patient still booked it, with their token)
ALTER TABLE appointments ADD COLUMN booked_via text CHECK (booked_via IN ('ASSISTANT'));
