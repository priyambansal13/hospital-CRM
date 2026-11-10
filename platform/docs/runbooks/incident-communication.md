# Incident communication

Hospitals hear about an incident from us before their patients complain to them.

## When

- Post on the status page **within 15 minutes** of any page, even if the cause is unknown.
- Update it at least **every 30 minutes** while the incident is open.
- Post a final update when it is resolved.

## Where

1. **Console → Status page** (`/platform/status`, the `status:manage:tenant` permission, which MediCare support has):
   - pick the impact and the affected components;
   - write the first message;
   - then post updates (investigating → identified → monitoring → resolved).
2. What that triggers:
   - the public page at `/status` shows the incident;
   - every hospital staff page shows a banner while it is open;
   - the static copy at `status.<domain>` (bucket, updated every minute) follows on its own.
3. For a **critical** incident lasting more than 30 minutes, e-mail the owners of affected hospitals. The console lists them under Hospitals.

## What to write

| Impact | When | Example |
|---|---|---|
| Minor | Slow, or some requests fail; workarounds exist | "Online booking is slow for some hospitals. Bookings still go through; the front desk is not affected." |
| Major | A component is partly down | "Online payments are failing. Patients can choose pay at the hospital; we will confirm when online payment is back." |
| Critical | A component is down for everyone | "Sign-in is down for staff and patients. We are working on it; next update by 11:30 IST." |
| Planned maintenance | Announced 3 days ahead, Sunday 01:30–05:30 IST | "Database maintenance: bookings may pause for up to 2 minutes between 02:00 and 02:30 IST." |

- Say what people will notice and what to do meanwhile (pay at the hospital, call the desk), never internal causes or names.
- Always give the time of the next update.
- **Never** name a hospital or a patient. The page is public.

## Planned maintenance

- Post it as **Planned maintenance** with a start and end time; it shows as scheduled.
- When the window starts, post an update with status "monitoring" (in progress).
- When it is done, post "resolved".
