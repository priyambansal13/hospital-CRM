# Handoff: where work stopped (2026-11-10, after Phase 30 part 2)

## State
- Phases 0–27 and 29 are built; M5 (AI) is complete; M6: Phase 26 (patient memberships) and Phase 27 (custom fields, forms, workflow rules, webhooks, API keys, FHIR read API, LIS connector; new integration-service on 4416) done 2026-10-31; Phase 29 (analytics warehouse and dashboards, new analytics-service on 4417; Ops agent, morning brief, care-gap reminders, no-show outreach) done 2026-11-01. Phase 28 (video) is the only M6 phase left and is skipped for now (user decision 2026-11-01). UI v2 (design system, staff sidebar, live-data home pages, dashboards) on 2026-10-31. Phase 22: AI foundation and the knowledge-only concierge (`ai-assistant-service` on 4415). On 2026-10-31: Phase 23 (concierge booking tools with Confirm cards), Phase 24 (lab report explainer, doctor pre-visit summary), Phase 25 (AI scribe, deterministic prescription safety, the concierge on WhatsApp). All AI work ran on the offline dev model only.
- **M7 started: Phase 30 part 1 done 2026-11-01** (IMPLEMENTATION-PLAN.md, Phase 30):
  - a database-server registry, with a second local Postgres (`postgres-b`, registered as pg-2, DEDICATED, by `mc test servers`);
  - dedicated-server hospitals (`mc tenant create --server`);
  - `mc tenant move` (logical replication, about 5 s read-only);
  - release rings (`mc migrate --max-ring`, `mc migrate status`, `mc tenant ring`);
  - encrypted per-hospital backups with restore drills (`mc backup run|list|drill|status`);
  - the ops image, and CronJobs and Terraform for backups (written, not yet run in a cluster).
  - Tests: `mc test servers` (27), `mc test backups` (15).
  - Local infra changes: Postgres `wal_level=logical`, `max_connections=600`; PgBouncer idle timeout 20 s and `server_login_retry` 1 s; new secrets `REPLICATION_PASSWORD` and `BACKUP_MASTER_KEY` (`mc configure`).
- **2026-11-09, docs and SEO** (user requests):
  - [APP-FLOWS-AND-LOGINS.md](APP-FLOWS-AND-LOGINS.md): every login and role, screen by screen;
  - [SALES-STORY.md](SALES-STORY.md): the sales story;
  - [SEO-AND-ADS.md](SEO-AND-ADS.md): the SEO and ads plan;
  - and **hospital-site SEO is built** (SEO-AND-ADS §2.1, `mc test seo`, 36 checks). See "SEO notes" below.
- **2026-11-10, the rest of SEO and ads** (user request "rest of seo and ads first"): the marketing site (features, segments, security, guides, demo form, pricing FAQ), the growth funnel (attribution with consent, leads, conversions, Meta Conversions API and a Google Ads file, console Growth page), and hospitals' Search and ads page (description, branch areas, profile checks, campaign links with bookings by campaign, Google Business Profile and ad-rules checklists), old branch addresses, doctor photos, sharing cards. `mc test growth` (40 checks) and Playwright `p30-seo-ads`. See "Growth notes" below.
  - Also fixed: the notification dispatcher's retry update failed (`power(integer, text)`), so after any failed send it stopped sending for that hospital; MediCare's own staff e-mails had been stuck since 2026-11-09.
- **2026-11-10, Phase 30 part 2** (user said yes): load test, failure tests, objectives and alerts, runbooks, status page, production Terraform. See [OPERATIONS.md](OPERATIONS.md) and "Operations notes" below.
  - **Verification at hand-off:**
    - Passed: unit tests, typechecks and lint everywhere; `mc test chaos` (all 17, before the last relay change), `status` (16), `growth`, `onboarding`, `wave3` (with the new hours check), `seo`, `gaps`, `console`, `queue`, `race`, `analytics`, `payments` (run alone, 45); `mc k8s check production`.
    - **Still to rerun on a quiet machine** (they failed only while the laptop was overloaded, load average 20–50): `servers`, `wave4`, `wave5`, `search`, `backups`, `chaos` (after the relay change that only stops a pass on Kafka send errors), and the leak test `tenancy` (it has fixtures for the two new routes).
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
  - `mc test memberships` (22 checks) covers Phase 26; it switches the module on for citycare and resets it afterwards.
  - `mc test workflows` (31 checks) and `mc test integrations` (32 checks) cover Phase 27; both switch their module on for citycare and reset it.
  - `mc test analytics` (24 checks) and `mc test ops` (38 checks) cover Phase 29; both switch `analytics` (and `ai_ops`) on for citycare and reset them. Run `mc test ops` once before the leak test (it needs an Ops question).
  - The tenancy leak test has 1397 checks and found 0 leaks.
  - Admin Staff and Roles pages read everyone's roles in one call (`GET entitlement v1/user-roles`); one call per person used up Kong's 1200/min per-IP limit once citycare had hundreds of test staff (2026-10-31).
- Git: one repo for all three folders, at https://github.com/priyambansal13/hospital-CRM (`main`).
  - Everything up to Phase 27 is pushed.
  - CI workflows are in `.github/workflows` (backend, frontend, platform), with path filters. They pass on GitHub, as does the security workflow (2026-10-31, UI v2 commit 486ac93).
  - Image builds wait for the `GCP_WIF_PROVIDER` repo variable.
  - The integration job is manual (workflow_dispatch).

## SEO notes worth knowing (2026-11-09)
- **Doctor addresses:**
  - `provider.doctors.slug` comes from migration `0003_doctor_slugs` (backfill in SQL) and `DirectoryRepo.assignSlug` on create and update (nest-common `slugify`; the two must stay in step).
  - Old addresses are kept in `retired_slugs`. `GET v1/public/doctors/:idOrSlug` accepts either, and the page redirects (308) to the current slug.
- **Other addresses** are not stored:
  - branches use `slugify(name)`, from tenant-service `GET v1/public/branches`;
  - specialties, tests and packages use the lower-cased code (`specialtySlug` / `testSlug` in `@mc/features/seo`).
- **After deploying:** `mc migrate`, then `mc search reindex --all` (new command), so search results carry `slug`. Results without one link by id and are redirected.
- **Helpers:** `@mc/features/seo` provides `site()` (canonical origin from branding `primaryHost`; indexable when ACTIVE or READ_ONLY), `pageMeta`, `NO_INDEX`, `JsonLd` and the schema.org builders.
- **Indexing:** every zone layout is `noindex`, and public pages opt in. A new public page must call `pageMeta()`, or it stays out of search.
- **robots.txt and sitemap.xml** are route handlers in zone-shell (`app/robots.txt`, `app/sitemap.xml`), built per host. A new public section needs an `Allow` line and sitemap entries.
- **Tests:** `mc test seo` creates 3 test doctors in citycare (left unpublished) and a `seoNNNNNN` hospital (marked DELETED at the end).

## Operations notes worth knowing (2026-11-10, Phase 30 part 2)
- **Load test:**
  - `mc load prepare` (the loadtest hospital, `platform/load/.data/loadtest.json` with patients' refresh tokens, not committed);
  - `mc load run --profile local|rush [--base --host]` (k6 via Docker).
  - Each run writes the rotated refresh tokens back, so the next run needs no new sign-ins. If they are lost, prepare signs patients in again (OTP cap 500 per hospital per hour).
  - Refresh answers **201**, not 200.
  - Hours for the load doctors: deleting old hours took ages and failed (500) until the fix below.
- **Failure tests:** `mc test chaos` stops `redpanda`, `redis` and `opensearch` (this project's compose only) and starts them again in `finally`. `CHAOS_ONLY=kafka,redis,payments,search` runs a subset. A payment outage is `POST /internal/simulator/outage {seconds}` on billing-service (dev only).
- **Behaviour changes worth knowing:**
  - `/health/ready` fails only on the control database; Redis down shows `status: degraded`.
  - Redis commands time out after `REDIS_COMMAND_TIMEOUT_MS` (1 s), and Redis errors are 503 `DEPENDENCY_UNAVAILABLE`.
  - The capabilities cache in entitlement-service is optional.
  - Kafka sends give up after `KAFKA_SEND_TIMEOUT_MS` (15 s).
  - Removing hours closes the times that have appointment history instead of deleting them.
- **Alerts:**
  - `platform/deploy/helm/medicare-platform/files/prometheus-rules.yaml` plus its `.test.yaml`; edit both, then run `mc k8s check <env>`, which also runs promtool and `terraform validate`.
  - Alert summaries use `$labels` and `$value` (plain rule format; the template wraps the file with `.Files.Get`).
- **Status page:**
  - tenant-service `src/status` (components → services map in `status.service.ts`);
  - the console page `/platform/status`;
  - the public `/status`;
  - `mc status publish` (`scripts/status-page.mjs`);
  - `mc test status`.
  - The new permission `status:manage:tenant` (PLATFORM_SUPPORT) needs an entitlement-service restart to load, as any module YAML change does.
- **Test hospitals pile up and slow everything locally.** Every active hospital adds work to every service's outbox relay (all databases, twice a second) and to jobs such as hold expiry. On 2026-11-10, 22 `move…`/`vip…` hospitals left active by `mc test servers` runs made suites that wait on events fail under load (payments, wave4, wave5, servers). They were soft-deleted (status DELETED; nothing purged), and `mc test servers` now marks its two hospitals DELETED at the end. After restarting `mc dev`, give it a few minutes: services run per-hospital start-up work across about 100 databases. Judge flaky suites only once the load average is below about 15.
- **Production:**
  - `deploy/terraform/prod-india` (validate locally with `terraform init -backend=false`; the gcs backend needs `-backend-config=bucket=…`);
  - `deploy/environments/production/values.yaml` (placeholders `<…>` from `terraform output`);
  - Argo CD `applicationset-production.yaml`.

## Growth notes worth knowing (2026-11-10)
- **Where things live:**
  - marketing words: `frontend/apps/zone-shell/src/lib/marketing.ts` (must stay true of the product);
  - pages under zone-shell `app/features`, `app/for`, `app/security`, `app/resources`, `app/demo`, each calling `marketingOnly()` (404 on a hospital's host) and wrapped in `MarketingFrame`. On a hospital's host the frame renders no tracking and no marketing links.
- **Data (control DB, tenant-service migration `0005_growth`):**
  - `signups.attribution` and `ads_consent`;
  - `leads`;
  - `conversions` (LEAD, SIGNUP, READY, PAID; once each; hashed e-mail).
  - `GrowthJob` (every 10 minutes, `GROWTH_JOB_MS`): records PAID from subscription-service invoices, then sends to Meta when `META_PIXEL_ID` and `META_CAPI_TOKEN` are set. It also runs on `POST /internal/growth/run`.
- **Cookies:**
  - marketing host: `mc_attr` (UTM tags, landing page; click ids only with consent) and `mc_consent` (`ads` or `essential`);
  - hospital hosts: only `mc_src` ("source / campaign", from the hospital's own links).
  - Never add an ad tag outside `MarketingFrame`.
- **Hospital side:**
  - tenant migration `0002_branch_seo` (`branches.area`, `branch_slugs`; a rename stores the old slug);
  - scheduling `0010_campaign` (`appointments.campaign`, online bookings only);
  - analytics `0002_campaign` (`fact_appointments.campaign`, dimension `campaign`);
  - provider: `photoUrl` is editable on the doctor profile;
  - branding `description` (saving it alone doesn't tick the setup wizard's branding step).
- **Sharing card:** zone-shell `app/og.png` (next/og); `pageMeta` uses it unless a page passes `image`.
- **Tests:** `mc test growth` deletes its own demo requests at the end. It renames Aarogya's Noida branch and puts it back, and sets and clears Dr. Asha Rao's photo. The browser test `p30-seo-ads` leaves one "E2E Clinic" demo request.
- **Local data note:** the console browser test (p18) publishes a new `DIAG_CENTER_PRO_E*` plan on every run, so `/pricing` lists many copies locally. Marketing pages show each plan name once (`distinctPlans`), but `/pricing` still lists them all.

## Phase 29 notes worth knowing (2026-11-01)
- analytics-service is the 17th service (port 4417, schema `analytics`, tenant only, consumer group `analytics.warehouse`). Same new-service steps as Phase 27 (configure, build, db bootstrap, migrate, gateway sync, PgBouncer restart, `mc dev` restart). ai-assistant-service now publishes `assistant.events` (relay on): `mc db bootstrap` creates the topic.
- Both modules are off by default; aarogya (showcase) has `analytics` and `ai_ops` on. Switching `analytics` on backfills the warehouse from the services (progress: `GET /api/analytics/v1/analytics/status`); `POST /internal/tenants/:t/analytics/backfill` re-runs it. Switching `ai_ops` on drafts the care-gap wording (Batch Mode); nothing is sent until an admin approves it on `/admin/ops`.
- The warehouse consumer writes even when entitlement-service cannot be reached (it lives in the hospital's own database); events that failed at a cold start can be replayed with `mc events replay <topic>`.
- Jobs: morning brief every 10 min from 7 a.m. branch time (`OPS_BRIEF_HOUR`), no-show outreach every 15 min from 5 p.m. (`NOSHOW_OUTREACH_HOUR`, threshold `NOSHOW_RISK_THRESHOLD`=3), care gaps hourly check / weekly per rule, Batch Mode poll every minute (`BATCH_POLL_MS`). Internal triggers: `POST /internal/tenants/:t/ops/briefs {hour}` (4415), `POST /internal/tenants/:t/noshow-outreach {hour}` (4405), `POST /internal/tenants/:t/ops/batches` (4415).
- Approved care-gap wording and sent reminders survive switching the module off and on (on purpose); `mc test ops` clears them at its start.
- With a real Gemini key, also try `GEMINI_OPS_MODEL` / `GEMINI_BATCH_MODEL` and a real Batch Mode job (the adapter has not called the API).

## Resume here (ask first)
Choose one:
1. **Phase 30 is done** (part 2 on 2026-11-10). What's left of it needs a GCP project: apply the Terraform, run the CronJobs, a DR test, and `mc load run --profile rush` on staging. Code items left: backup keys in KMS, `mc backup restore`, Redis TLS and Kafka SASL in the clients, a Grafana dashboard. Next phase by the plan: **Phase 31 (security and compliance)**, ask first. Phase 28 (video consultations) is skipped for now (user decision 2026-11-01).
2. **Real-provider runs**, once the user provides keys or accounts:
   - Gemini: a valid key, then `LLM_PROVIDER=gemini` and `mc test assistant`, `mc test concierge` `mc test copilot` and `mc test scribe` against the real model, plus the Ops agent, the morning brief and a Batch Mode job (prompt tuning; set `GEMINI_COPILOT_MODEL` / `GEMINI_TRANSCRIBE_MODEL` if the defaults are not available), and a real recorded consultation;
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

**Local LLM setting (2026-10-31):** the services pick up a `GEMINI_API_KEY` that Google rejects (401), so `backend/.env` has `LLM_PROVIDER=dev` (the offline dev model). Remove that line once a valid key is set. `mc configure` used to rewrite `backend/.env` and drop such hand-set lines (it happened when integration-service was added, and the AI suites then hit the real API); it now keeps `LLM_PROVIDER`, `OTEL_EXPORTER_OTLP_ENDPOINT` and `WEBHOOK_ALLOW_PRIVATE`. Tracing is currently off locally (the endpoint line was lost in that rewrite): to turn it back on, set `OTEL_EXPORTER_OTLP_ENDPOINT` in `backend/.env` to the Jaeger container `mc-jaeger` (UI on :16686) and restart `mc dev`.

**Not run, on purpose:** `mc tenant purge`. It permanently destroys a hospital's data, and running it was blocked as irreversible. The user decides whether to run it (only on DELETED test hospitals, and only after `mc tenant export`).

## Phase 27 notes worth knowing
- integration-service is the 16th service (port 4416, schema `integration`, control + tenant). A new service needs `mc configure`, a backend build, `mc db bootstrap` (schemas, roles, Kafka topic `integration.events`), `mc migrate`, `mc gateway sync`, a PgBouncer restart and an `mc dev` restart.
- Scheduling's doctor read model now has `specialty_codes`; after deploying, republish doctors (provider `POST /internal/tenants/:t/doctors/republish`) so forms per specialty apply.
- Both modules are off by default (`mc module enable <slug> workflows|integrations`). Leave them off on citycare: the suites switch them on and reset them.
- Webhook dispatch runs every 3 s in-process (`WEBHOOK_DISPATCH_MS`); in production set `WEBHOOK_ALLOW_PRIVATE=false` (the default when NODE_ENV=production).
- The leak test needs a field, form, rule, endpoint, delivery and API key in citycare: run `mc test workflows` and `mc test integrations` once before it.

## Phase 26 notes worth knowing
- The module is off by default; `mc module enable <slug> memberships` switches it on (seeds Care+ and Family+). It is on for aarogya (showcase). Leave it off on citycare: other suites book further ahead than the 14-day free window.
- Booking rules apply only to a patient's own online booking (`b.rules` in `bookSlot`); the front desk is never limited.
- Members-only times are not stored: `membersOnly(slotId, startsAt, pct)` (scheduling `membership.ts`) is a stable hash, so the public slot list and the booking check always agree.
- Membership invoices have no branch (`invoices_branch_required` check allows that only for MEMBERSHIP); the invoice DTO shows the branch name "Membership". Branch-scoped staff do not see them.

## UI v2 notes worth knowing (2026-10-31)
- **Design system** (`frontend/packages/ui`): `theme.css` v2 (tokens, Plus Jakarta Sans, dark mode by system or the toggle, stored in `localStorage` `mc-theme`); class names are a stable contract for all zones. New components: `Kpi`, `Bars`, `Columns`, `Icon`, `iconFor` (label first, then key), `iconForSpecialty`. Client parts in `src/shell.tsx` (command palette, theme toggle, mobile menu).
- **Frame:** staff get a sidebar grouped by area (`ZoneFrame` passes each item's zone as the group) and a top bar with the Ctrl/⌘ K palette; patients and visitors get the top bar (visitors: Find a doctor / Lab tests by the hospital's modules) and a footer. `ZoneFrame wide` for full-bleed pages.
- **Home pages** (zone-shell): `hospital-home.tsx` (live data: search, next available doctors, specialties, doctors, packages, branches) and `platform-home.tsx` (live plans).
- **Dashboards:** admin overview (KPIs, the week ahead, booking channels, busiest doctors) from `GET /api/scheduling/v1/stats/overview` (scoped to the branches the person manages); desk, lab, billing and collections use `Kpi` tiles.
- **Screens (round 2):** doctors land on "Today" (`/doctor`: next patient, waiting, notes to sign, critical values, the week); doctors without a profile still go to their schedule. Signed-in patients see their panel on `/care` (next visit, reports ready, bills, health record) and their links in a bar under the header (sorted by use). Branded split sign-in page. Empty states have an icon. Brand-derived colours (`--brand-soft`, `--brand-ink`) are recomputed per hospital.
- **Screens (round 3):** two-column layouts (`.mc-split`): the consult page (notes left; copilot, allergies, documents, history right), admin doctors / staff / branches (list left, add form right), patient booking (form left, summary right). KPI tiles on the MediCare console and on My bills.
- **Turbopack note:** a rebuilt workspace package (`@mc/ui`, `@mc/features`) is not always picked up by running zones: restart `mc dev` before judging a UI change.
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
