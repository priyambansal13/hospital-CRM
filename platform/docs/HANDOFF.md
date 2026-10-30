# Handoff: where work stopped (2026-10-30, after wave 4)

## State
- Phases 0–22 are built (Phase 22: AI foundation and the knowledge-only concierge, `ai-assistant-service` on 4415).
- The flow review is in [ROLE-FLOWS-AND-GAPS.md](ROLE-FLOWS-AND-GAPS.md). See §8 "Fix log" for details.
  - Wave 1 (15 gaps): fixed 2026-10-25.
  - Wave 2 (access control and staff lifecycle): fixed 2026-10-30.
  - Wave 3 (front desk and lab completeness, screens for existing APIs, missing notifications): fixed 2026-10-30.
  - Wave 4 (production readiness that needs no provider account): done 2026-10-30. See §8 for what each item still needs.
- Tests:
  - `mc test gaps` covers wave 1.
  - `mc test wave2` covers wave 2 (45 checks).
  - `mc test wave3` covers wave 3 (31 checks).
  - `mc test wave4` covers wave 4 (48 checks).
  - The tenancy leak test has 1086 checks and found 0 leaks.
- Git: one repo for all three folders, at https://github.com/priyambansal13/hospital-CRM (`main`).
  - Waves 2 and 3 are pushed.
  - CI workflows are in `.github/workflows` (backend, frontend, platform), with path filters. All three pass on GitHub (2026-10-30).
  - Image builds wait for the `GCP_WIF_PROVIDER` repo variable.
  - The integration job is manual (workflow_dispatch).

## Resume here (ask first)
Choose one:
1. **Phase 23** (the next AI phase in IMPLEMENTATION-PLAN.md).
2. **Real-provider runs**, once the user provides keys or accounts:
   - Razorpay: test keys, the recurring adapter for `SAAS_PAYMENTS=razorpay`, and Route;
   - MSG91 with DLT templates;
   - Cloud KMS (`KEY_WRAPPER=gcp-kms`);
   - Gemini;
   - ClamAV;
   - a GCP project for staging.
3. **Remaining smaller gaps:**
   - E-9: the doctor's form for amending diagnoses;
   - owner and MediCare-staff notifications;
   - B-7 rate limits;
   - Playwright in CI;
   - OpenTelemetry tracing;
   - purging soft-deleted documents;
   - support "act as" (Phase 31);
   - approvals and expiry for overrides and coupons.

**Not run, on purpose:** `mc tenant purge`. It permanently destroys a hospital's data, and running it was blocked as irreversible. The user decides whether to run it (only on DELETED test hospitals, and only after `mc tenant export`).

## Wave 4 notes worth knowing
- **SaaS payments:**
  - `SAAS_PAYMENTS`: simulated in dev, manual elsewhere.
  - Cards go through card sessions and the gateway's hosted page; locally a simulated page at `/api/subscription/v1/sim-gateway/mandate/:id`.
- **Payout account:** replacing it needs a step-up code (`POST /api/iam/v1/me/step-up` with purpose `PAYOUT_ACCOUNT`).
  - Payouts are held for `PAYOUT_HOLD_HOURS`.
  - History: `GET /api/billing/v1/payment-account/history`.
- **Keys:**
  - `KEY_WRAPPER` (local or gcp-kms);
  - `MC_MASTER_KEY_PREVIOUS` for master key rotation;
  - `mc keys rotate <slug>` and `mc keys rewrap`.
- **SMS:**
  - `SMS_PROVIDER` (mailpit or msg91), with `MSG91_AUTH_KEY` and `MSG91_OTP_TEMPLATE_ID`;
  - the DLT ids are on each SMS template.
- **Ops:**
  - probes: `/health/live` and `/health/ready`;
  - metrics on port service + 5000 locally (9464 in the cluster);
  - DLQ tools: `mc events dlq`, `mc events replay <topic>`;
  - retention: `OUTBOX_RETENTION_DAYS` (7) and `PROCESSED_EVENTS_RETENTION_DAYS` (30).
- **Offboarding:**
  - `mc tenant export <slug>` writes to `platform/exports/` (git-ignored: it holds patient data);
  - `PURGE_AFTER_DAYS` (30).
- **CI:**
  - the `security` workflow runs CodeQL, `pnpm audit` and a secret scan;
  - Trivy cannot read pnpm 10+ lockfiles, so dependencies are checked with `pnpm audit`.

## Wave 3 notes worth knowing
- **Cash refunds:** a refund of a counter payment waits in `HAND_BACK` until the desk records "Handed back" (`/desk/collections`).
- **Staff lab booking:**
  - Page: `/lab/book` (permission `lab_order:create:branch`).
  - Desk slots: `GET v1/desk/lab-slots` allows the slot running now.
- **Doctor agenda:**
  - `AgendaJob` in scheduling runs every 10 minutes.
  - It sends from `AGENDA_HOUR` (7 by default) at the branch.
  - It sends once per doctor per day (table `agenda_sent`).
  - Test hook: `POST :4405/internal/tenants/:id/agenda {hour}`.
- **Late check-in:** `POST desk/appointments/:id/check-in` also accepts a NO_SHOW of today (D-12).
- **Lab catalog editor:** `PATCH admin/lab-tests/:id` takes `referenceRanges`, `turnaroundHours` and `fastingHours`; `PATCH admin/lab-packages/:id` takes `testCodes`.

## Wave 2 notes worth knowing
- **Branch scoping:**
  - Capabilities carry `branchScopes` and `branchIds`.
  - Use `inBranch`, `assertInBranch` and `branchesFor` from `@mc/entitlements-sdk` (backend) and `branchesFor` from `@mc/features` (screens).
  - The guard checks a `branchId` given in the params, the query or the top-level body. A nested branch has to be checked by the code itself (example: desk walk-in).
- **Role templates:** template sync now removes grants that a role the hospital has *not customised* no longer has.
- **Admin audit:**
  - `@AdminAudited('TYPE')` records after the change succeeds and retries in the background.
  - `recordAdminAction` records inside the transaction, so the change fails if the audit log is down.
- **Critical escalation:**
  - Runs every minute (`CriticalEscalationJob`).
  - Test hook: `POST :4412/internal/tenants/:id/lab/critical-escalation {dueNow}`.
- **Not done in wave 2 (by design):**
  - Staff SMS: there is no staff phone or channel.
  - Chat alerts by e-mail or push: the assistant service has no outbox.
  - Patient registration and the chat-request queue stay hospital-wide: patients are not tied to a branch.

## Before working
- From `platform/`, start the dev stack with `node scripts/mc.mjs dev` (run it in the background). After pulling new migrations, run `node scripts/mc.mjs migrate`.
- Do not stop the agentic-commerce or PayFlow Docker containers.
- Each folder's `.github/workflows` sits inside that folder, so GitHub doesn't run it. Moving them to the repo's top-level `.github/` with path filters is an open to-do.
- After each wave:
  - update the fix log in ROLE-FLOWS-AND-GAPS.md;
  - update the Status section of IMPLEMENTATION-PLAN.md;
  - update the memory files;
  - report, and ask before starting the next wave.
