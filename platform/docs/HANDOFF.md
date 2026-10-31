# Handoff: where work stopped (2026-10-31, after wave 5)

## State
- Phases 0–22 are built (Phase 22: AI foundation and the knowledge-only concierge, `ai-assistant-service` on 4415).
- The flow review is in [ROLE-FLOWS-AND-GAPS.md](ROLE-FLOWS-AND-GAPS.md). See §8 "Fix log" for details.
  - Wave 1 (15 gaps): fixed 2026-10-25.
  - Wave 2 (access control and staff lifecycle): fixed 2026-10-30.
  - Wave 3 (front desk and lab completeness, screens for existing APIs, missing notifications): fixed 2026-10-30.
  - Wave 4 (production readiness that needs no provider account): done 2026-10-30. See §8 for what each item still needs.
  - Wave 5 (the remaining smaller gaps: E-9 amend form, owner and MediCare-staff notices, B-7 real client IP and OTP caps, document purge, override end dates, OpenTelemetry tracing, Playwright in CI): done 2026-10-31.
- Tests:
  - `mc test gaps` covers wave 1.
  - `mc test wave2` covers wave 2 (45 checks).
  - `mc test wave3` covers wave 3 (31 checks).
  - `mc test wave4` covers wave 4 (48 checks).
  - `mc test wave5` covers wave 5 (15 checks).
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
3. **What is still open from the review** (small; none blocks Phase 23):
   - support "act as" (Phase 31);
   - captcha on signup and patient OTP;
   - approvals for overrides and coupons;
   - the first GitHub run of the manual integration job (it now includes Playwright).

**Fix first (configuration, 2026-10-31):** after `mc dev` was restarted, the services picked up a `GEMINI_API_KEY` (or Vertex setting) that Google rejects (401). The assistant then calls Gemini instead of the offline dev model, and that breaks `mc test assistant`, `plans`, `onboarding`, part of `wave2` and `wave5`, and `p22-assistant.spec.ts` (turning on the AI module seeds embeddings). Either set a valid key, or put `LLM_PROVIDER=dev` in `backend/.env` and restart `mc dev`, then rerun those suites. Locally, tracing is on (`OTEL_EXPORTER_OTLP_ENDPOINT` in `backend/.env`, Jaeger container `mc-jaeger`, UI on :16686). To turn it off, remove the line, run `docker rm -f mc-jaeger`, and restart `mc dev`.

**Not run, on purpose:** `mc tenant purge`. It permanently destroys a hospital's data, and running it was blocked as irreversible. The user decides whether to run it (only on DELETED test hospitals, and only after `mc tenant export`).

## Wave 5 notes worth knowing
- **Tracing:**
  - Every service starts with `--import @mc/nest-common/tracing`; it does nothing unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set (in the environment or `backend/.env`).
  - To look at traces locally: `docker run -d --name mc-jaeger -p 127.0.0.1:4318:4318 -p 127.0.0.1:16686:16686 jaegertracing/jaeger:2.11.0`, add `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` to `backend/.env`, restart `mc dev`, open http://localhost:16686.
  - Events carry `traceparent`; consumer spans are named `<event type> process`.
- **Signups:** a sweep (every 30 s, `SIGNUP_SWEEP_MS`) moves PROVISIONING signups to READY (owner e-mail) or FAILED after 10 minutes (staff notice to `customer:manage:tenant` on the HQ account, `HQ_SLUG`).
- **Client IP:** use `clientIp(req)` from `@mc/nest-common`, never `req.ip`. Kong sets X-Real-IP from trusted proxies (`KONG_TRUSTED_IPS`).
- **OTP caps:** `OTP_PER_IP_PER_10_MIN` (100000 in dev via `mc configure`) and `OTP_PER_HOSPITAL_PER_HOUR` (500).
- **Purges and expiries:** `DOCUMENT_PURGE_DAYS` (30); override `until` dates are enforced by the billing tick.

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
- CI lives in the repo's top-level `.github/workflows` (path filters per folder).
- After each wave:
  - update the fix log in ROLE-FLOWS-AND-GAPS.md;
  - update the Status section of IMPLEMENTATION-PLAN.md;
  - update the memory files;
  - report, and ask before starting the next wave.
