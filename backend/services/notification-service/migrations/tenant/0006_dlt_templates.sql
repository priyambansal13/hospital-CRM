-- India's DLT rules (docs/ROLE-FLOWS-AND-GAPS.md A-2): an SMS goes out only through a template registered on the DLT
-- platform. Per message template: the provider's id for it (MSG91 flow/template id) and the DLT template id.
-- Variables are sent by name, so the registered template uses the same names as ours ({{patientName}} → ##patientName##).
ALTER TABLE templates ADD COLUMN provider_template_id text;
ALTER TABLE templates ADD COLUMN dlt_template_id text;
