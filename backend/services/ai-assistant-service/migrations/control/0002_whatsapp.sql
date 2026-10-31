-- Phase 25: WhatsApp Business numbers → hospital (Meta calls one webhook for every number; this says whose it is).
CREATE TABLE whatsapp_numbers (
  phone_number_id text PRIMARY KEY,       -- Meta's id for the business number
  tenant_id uuid NOT NULL,
  display_number text NOT NULL,           -- +91 98xxxxxxx, shown to staff
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON whatsapp_numbers (tenant_id);
