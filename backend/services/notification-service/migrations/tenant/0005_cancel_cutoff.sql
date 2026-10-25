-- The confirmation e-mail said "2 hours"; the cutoff is the hospital's setting (docs/ROLE-FLOWS-AND-GAPS.md F-3).
-- Only untouched default text is changed: a hospital's own wording stays.
UPDATE templates SET body = replace(body, 'online changes close 2 hours before', 'online changes close {{cutoff}} before'), updated_at = now()
WHERE key = 'appointment_confirmed' AND body LIKE '%online changes close 2 hours before%';
