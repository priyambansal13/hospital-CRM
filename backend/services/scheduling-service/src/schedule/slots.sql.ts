/**
 * Slot generation (docs/LLD.md §5.1), done in Postgres so time zones and DST are handled by the database:
 * local date + local time in the branch's zone → timestamptz. Idempotent (ON CONFLICT DO NOTHING); never touches
 * existing slots, so booked/held slots survive regeneration. Days covered by leave are generated as BLOCKED.
 * $1 = doctor id, $2 = horizon in days.
 */
export const GENERATE_SLOTS = `
INSERT INTO slots (id, doctor_id, branch_id, starts_at, ends_at, mode, status, template_id)
SELECT gen_random_uuid(), t.doctor_id, t.branch_id,
       s.local AT TIME ZONE b.timezone,
       (s.local + make_interval(mins => t.slot_minutes)) AT TIME ZONE b.timezone,
       t.mode,
       CASE WHEN EXISTS (SELECT 1 FROM doctor_leaves l WHERE l.doctor_id = t.doctor_id AND d.day::date BETWEEN l.from_date AND l.to_date)
            THEN 'BLOCKED' ELSE 'OPEN' END,
       t.id
FROM availability_templates t
JOIN branches b ON b.id = t.branch_id AND b.active
-- ::timestamp matters: generate_series over dates would yield timestamptz (UTC), and "AT TIME ZONE" would then
-- convert the wrong way. Local wall-clock timestamps + AT TIME ZONE zone = the correct instant.
CROSS JOIN LATERAL generate_series((now() AT TIME ZONE b.timezone)::date::timestamp, ((now() AT TIME ZONE b.timezone)::date + $2::int)::timestamp, interval '1 day') AS d(day)
CROSS JOIN LATERAL generate_series(d.day + t.start_time, d.day + t.end_time - make_interval(mins => t.slot_minutes), make_interval(mins => t.slot_minutes)) AS s(local)
WHERE t.doctor_id = $1
  AND extract(isodow FROM d.day) = t.day_of_week
  AND d.day::date >= t.effective_from AND (t.effective_to IS NULL OR d.day::date <= t.effective_to)
  AND s.local AT TIME ZONE b.timezone > now()
ON CONFLICT (doctor_id, starts_at) DO NOTHING`;

/** Local calendar date of a slot in its branch's zone. Alias s = slots, b = branches. */
export const LOCAL_DATE = `(s.starts_at AT TIME ZONE b.timezone)::date`;
