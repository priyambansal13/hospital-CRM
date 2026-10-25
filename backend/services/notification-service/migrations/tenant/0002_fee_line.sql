-- Phase 11: the confirmation email's fee line now comes from the planner ("₹500, pay at the hospital" or
-- "₹500, paid online"). Updates the default text only; templates a hospital has edited are left as they are.
UPDATE templates SET body = replace(body, 'Fee: {{fee}}, pay at the hospital', 'Fee: {{fee}}')
WHERE key = 'appointment_confirmed' AND channel = 'EMAIL' AND body LIKE '%Fee: {{fee}}, pay at the hospital%';
