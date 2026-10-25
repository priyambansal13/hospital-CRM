-- Phase 15: the "report ready" SMS says "a new document" (SMS never name tests or reports). Hospitals seeded with the
-- first wording get the new one; a template the hospital has edited is left as it is.
UPDATE templates SET body = '{{hospital}}: a new document for {{patientName}} ({{orderNo}}) is ready{{amendedNote}}. View it securely: {{link}}'
WHERE key = 'lab_report_ready' AND channel = 'SMS' AND language = 'en'
  AND body = '{{hospital}}: the lab report for {{patientName}} ({{orderNo}}) is ready{{amendedNote}}. View it securely: {{link}}';
UPDATE templates SET body = '{{hospital}}: {{patientName}} ({{orderNo}}) का नया दस्तावेज़ तैयार है। सुरक्षित रूप से देखें: {{link}}'
WHERE key = 'lab_report_ready' AND channel = 'SMS' AND language = 'hi'
  AND body = '{{hospital}}: {{patientName}} ({{orderNo}}) की लैब रिपोर्ट तैयार है। सुरक्षित रूप से देखें: {{link}}';
