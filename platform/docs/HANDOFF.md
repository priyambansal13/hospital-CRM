# Handoff: where work stopped (2026-10-31, after Phase 25: M5 complete)

## State
- Phases 0–25 are built; M5 (AI) is complete. UI v2 (design system, staff sidebar, live-data home pages, dashboards) on 2026-10-31. Phase 22: AI foundation and the knowledge-only concierge (`ai-assistant-service` on 4415). On 2026-10-31: Phase 23 (concierge booking tools with Confirm cards), Phase 24 (lab report explainer, doctor pre-visit summary), Phase 25 (AI scribe, deterministic prescription safety, the concierge on WhatsApp). All AI work ran on the offline dev model only.
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
  - `mc test concierge` is the Phase 23 booking-task eval (28 checks); `mc test copilot` covers Phase 24 (report explainer and pre-visit summary, 27 checks). Run both before the leak test, which uses a card and a summary they leave.
  - `mc test scribe` (prescription safety + scribe, 26 checks) and `mc test whatsapp` (20 checks) cover Phase 25; the scribe suite also leaves a draft the leak test uses.
  - The tenancy leak test has 1141 checks and found 0 leaks.
- Git: one repo for all three folders, at https://github.com/priyambansal13/hospital-CRM (`main`).
  - Everything up to Phase 25 is pushed.
  - CI workflows are in `.github/workflows` (backend, frontend, platform), with path filters. They pass on GitHub, as does the security workflow (2026-10-31, UI v2 commit 486ac93).
  - Image builds wait for the `GCP_WIF_PROVIDER` repo variable.
  - The integration job is manual (workflow_dispatch).

## Resume here (ask first)
Choose one:
1. **M6** (Phase 26 onwards: memberships and other growth modules, IMPLEMENTATION-PLAN.md), ordered by customer demand: ask which first.
2. **Real-provider runs**, once the user provides keys or accounts:
   - Gemini: a valid key, then `LLM_PROVIDER=gemini` and `mc test assistant`, `mc test concierge` `mc test copilot` and `mc test scribe` against the real model (prompt tuning; set `GEMINI_COPILOT_MODEL` / `GEMINI_TRANSCRIBE_MODEL` if the defaults are not available), and a real recorded consultation;
   - WhatsApp: a WhatsApp Business account (Meta Cloud API): `WHATSAPP_PROVIDER=meta`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, the webhook URL registered with Meta, `mc whatsapp link <slug> <phoneNumberId> <number>`;
   - a licensed drug database behind the prescription-safety rules (the starter formulary is for development);
   - Razorpay: test keys, the recurring adapter for `SAAS_PAYMENTS=razorpay`, and Route;
   - MSG91 with DLT templates;
   - Cloud KMS (`KEY_WRAPPER=gcp-kms`);
   - ClamAV;
   - a GCP project for staging.
3. **What is still open from the review** (small):
   - support "act as" (Phase 31);
   - captcha on signup and patient OTP;
   - approvals for overrides and coupons;
   - the first GitHub run of the manual integration job (it now includes Playwright).

**Local LLM setting (2026-10-31):** the services pick up a `GEMINI_API_KEY` that Google rejects (401), so `backend/.env` now has `LLM_PROVIDER=dev` (the offline dev model). Remove that line once a valid key is set. Locally, tracing is on (`OTEL_EXPORTER_OTLP_ENDPOINT` in `backend/.env`, Jaeger container `mc-jaeger`, UI on :16686). To turn it off, remove the line, run `docker rm -f mc-jaeger`, and restart `mc dev`.

**Not run, on purpose:** `mc tenant purge`. It permanently destroys a hospital's data, and running it was blocked as irreversible. The user decides whether to run it (only on DELETED test hospitals, and only after `mc tenant export`).

## UI v2 notes worth knowing (2026-10-31)
- **Design system** (`frontend/packages/ui`): `theme.css` v2 (tokens, Plus Jakarta Sans, dark mode by system or the toggle, stored in `localStorage` `mc-theme`); class names are a stable contract for all zones. New components: `Kpi`, `Bars`, `Columns`, `Icon`, `iconFor` (label first, then key), `iconForSpecialty`. Client parts in `src/shell.tsx` (command palette, theme toggle, mobile menu).
- **Frame:** staff get a sidebar grouped by area (`ZoneFrame` passes each item's zone as the group) and a top bar with the Ctrl/⌘ K palette; patients and visitors get the top bar (visitors: Find a doctor / Lab tests by the hospital's modules) and a footer. `ZoneFrame wide` for full-bleed pages.
- **Home pages** (zone-shell): `hospital-home.tsx` (live data: search, next available doctors, specialties, doctors, packages, branches) and `platform-home.tsx` (live plans).
- **Dashboards:** admin overview (KPIs, the week ahead, booking channels, busiest doctors) from `GET /api/scheduling/v1/stats/overview` (scoped to the branches the person manages); desk, lab, billing and collections use `Kpi` tiles.
- **Showcase data:** `mc seed showcase` creates Aarogya Hospitals (http://aarogya.localhost:3400): 3 branches, 14 doctors with hours, 20 patients, about 125 bookings this week and today's walk-ins. Staff: `admin@aarogya.test`, `desk@aarogya.test`, doctors `<first>.<last>@aarogya.test` (dev staff password). Use it for demos and screenshots; City Care is full of test data.
- **Tests:** select by role and `aria-current`, not by layout classes (the smoke test was changed so). The palette button is "Go to a screen" (a "Search" label clashed with page search buttons).

## Phase 25 notes worth knowing
- **Prescription safety:** `records-service/src/prescribing/` (`drug-data.ts` starter formulary + interaction rules, `safety.ts` checks, `prescribing.ts` APIs and the scribe's recordings). A major interaction refuses a prescription with `INTERACTION_CONFLICT` unless `interactionOverride` is given; the consult page asks for the reason.
- **Scribe:** consent → recording (records, encrypted, deleted on sign or after `SCRIBE_AUDIO_HOURS`) → `POST /api/assistant/v1/assistant/scribe/encounters/:id/drafts` (transcribe, SOAP JSON, checks) → the consult page's draft form → "Use in visit notes" (PATCH with `aiDraftId`, then `drafts/:id/apply`). Feature `ai.scribe`, permission `copilot:use:own`. The dev model "transcribes" only WAV files that carry the transcript in their ICMT comment (see `tests/scribe.mjs` `mockRecording`).
- **WhatsApp:** `src/whatsapp/` in ai-assistant-service; webhook `/api/assistant/v1/public/whatsapp/webhook`; numbers in control table `assistant.whatsapp_numbers` (`mc whatsapp link|list`); patients in `assistant.wa_links`. Feature `ai.whatsapp` is off by default. The assistant caches a hospital's features for 30 s, so a switch takes up to 30 s to apply.

## Phase 24 notes worth knowing
- **Report explainer:** tools `list_my_reports` + `explain_report` (feature `ai.reports`). A report with any critical value is never explained: `ChatService` returns a fixed reply as soon as `explain_report` reports `criticalHeld`.
- **Pre-visit summary:** `POST /api/assistant/v1/assistant/copilot/appointments/:id/summary` (doctor's token; feature `ai.copilot`, permission `copilot:use:own`). Facts come from records, patient-service and diagnostics with the doctor's token; `checkCitations()` drops unsupported lines. Panel: `zone-doctor/src/lib/copilot.tsx` on the consult page.
- **Dates:** use `dateOnly()` from `@mc/nest-common` for Postgres `date` columns (node-pg gives local midnight; `toISOString()` shifts it a day back in India).
- **Tracing preload:** it must not register signal handlers (that held stopping services open under `mc dev`).

## Phase 23 notes worth knowing
- **Confirm cards:** `pending_actions` (15 minutes). Only `POST /api/assistant/v1/assistant/actions/:id/confirm` books, moves or cancels, with the patient's token; the card id is the idempotency key. Scheduling marks these bookings `booked_via = ASSISTANT` (header `x-mc-via`).
- **Feature `ai.booking`:** switch booking from the chat off per hospital in the console (feature override `{enabled:false}`); the model then gets no `propose_*` tools.
- **Dev model:** `llm/dev-agent.ts` understands "book … <doctor or symptom> <day> <morning>", "the second one", "cancel/reschedule my appointment", "my appointments", "how much is the … test". Test phrases must contain a booking word ("book", "doctor", "appointment").
- **Tool trace:** `messages.trace_enc` (encrypted) brings earlier tool results back to the model; `tool_calls` logs every call without the visit reason.

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
