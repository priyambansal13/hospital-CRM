# SMS or e-mail outage

**Alerts:**
- `MedicareNotificationsFailing` (page): more than 10% of sends fail on a channel.
- `MedicareNotificationsLate` (ticket): messages go out more than 15 minutes after they were due.

## What it means

- Booking confirmations, reminders, report-ready messages and staff notices are late or missing.
- Patients' **sign-in codes** (OTP) come from iam-service through the same SMS provider. If SMS is down, new sign-ins fail: Major.

## Do

1. **Which channel:** `mc_notifications_total{result=~"error|failed"}` by channel.
2. **The provider:** MSG91 (SMS) or the SMTP provider:
   - its status page;
   - our credentials in Secret Manager;
   - DLT template ids. An SMS template that isn't registered on DLT is skipped on purpose: the admin adds its id in Admin → Messages.
3. **Retries are automatic:** each message is retried with growing gaps (2, 4, 8… minutes) up to its limit, then marked FAILED.
   - Fixed on 2026-11-10: the retry itself failed in SQL, which stopped all sending for that hospital.
   - FAILED messages are not re-sent by themselves. Decide with the product owner whether a reminder that is now late should still go.
4. **Sign-in codes down:** post on the status page: "New sign-ins by code fail. People already signed in are not affected."

## Confirm

- The failure ratio is under 10%.
- `mc_notification_delay_seconds` is falling.
- A test message to a test number arrives.
