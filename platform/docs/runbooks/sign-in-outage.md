# Sign-in outage

**Signs:**
- Staff can't sign in: the Keycloak page errors or loops;
- patients can't sign in: the OTP request fails;
- the uptime check for `/login` fails.

## Do

1. **Staff (Keycloak):**
   - the Keycloak pods and their database (`keycloak` on `pg-1`);
   - the ingress for the login host.
   - A redirect loop after sign-in has been caused before by an oversized session cookie (see HANDOFF.md).
2. **Patients (OTP):**
   - iam-service;
   - Redis, where codes and refresh tokens live: [Redis outage](redis-outage.md);
   - the SMS provider: [SMS or e-mail outage](sms-email-outage.md).
3. **One hospital only:** its Keycloak organisation. An event to iam-service that dead-lettered means the organisation was never created: [events dead-lettered](events-dead-lettered.md).
4. **Status page:** sign-in, Critical if nobody can sign in.

## Confirm

A staff test account and a test patient number can both sign in on a test hospital.
