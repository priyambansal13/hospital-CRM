# MediCare: end-to-end flows by role, and gaps

Review of what is built through Phase 22 (2026-10-25). Every flow below was traced through the actual code: screens, server actions, APIs, events and notifications. The design docs were not taken on trust. The review covered:
- the patient zone and public pages;
- the desk, doctor and lab zones;
- the admin and account zones;
- the platform console and signup;
- the backend services, manifests, deployment config and CI.

The most serious claims were re-checked by hand before being listed. They are marked **[verified]** and include file references.

Legend: ✅ complete end to end · ⚠️ works but has gaps · ❌ missing or dead end. Severity: **H** high, **M** medium, **L** low.

---

## 1. Summary

The core of the product works end to end and is well built:
- **Discover, book and pay:** a patient finds a doctor, books, and pays online or at the hospital.
- **Front desk:** registers walk-ins, checks them in with tokens and collects payment.
- **Doctor:** sees a live queue, writes, signs and amends the visit, prescribes and orders labs.
- **Lab:** collects, enters results, verifies and publishes a QR-verifiable report.
- **Patient:** sees results, prescriptions, a timeline and who opened their record.
- **SaaS:** plans, the two-person plan approval, subscriptions, dunning, signup and the AI assistant.

Concurrency, idempotency, tenant isolation, encryption and audit of record access are strong throughout.

Four kinds of problem stand out:

1. **It cannot run in production yet.**
   - subscription-service crashes outside dev.
   - There is no SMS provider, so patients cannot log in (OTP) and no SMS is ever sent.
   - Staff never become ACTIVE, so they get no e-mail.
   - Signup e-mail ignores SMTP credentials.
   - SaaS recurring payments and Razorpay Route are simulated.
2. **Branch-level access control does not exist.** Every `:branch` permission is effectively hospital-wide.
3. **Some clinical-safety holes:**
   - lab values typed with a unit or a comma can be published as "normal";
   - critical values never escalate;
   - prescribing does not check allergies;
   - visits can be closed without a signed note.
4. **Dead ends in otherwise complete flows:**
   - video consults can be booked but there is no video;
   - X-ray/ECG-only lab orders can never be reported;
   - home-sample recollection and doctor-ordered tests for patients without the app get stuck;
   - staff cannot be offboarded;
   - an expired or cancelled hospital cannot reactivate;
   - nobody can export data or close an account.

### Top 15, in the order to fix

| # | Gap | Sev | Section |
|---|---|---|---|
| 1 | subscription-service throws at start outside dev (`SimulatedCards` always wired) **[verified]** | H · ✅ fixed (wave 4: manual mode) | 4.A |
| 2 | No SMS provider: OTP login and all SMS go to Mailpit only **[verified]** | H · ✅ adapter built (wave 4; needs an MSG91 account) | 4.A |
| 3 | Staff stay `INVITED` forever outside dev, so no staff e-mail and possibly no hospital membership lookup **[verified]** | H · ✅ fixed | 4.A |
| 4 | `:branch` permissions ignore `user_roles.branch_id`, so staff of one branch act on all branches **[verified]** | H · ✅ fixed (wave 2) | 4.B |
| 5 | Lab results with units or commas ("450 mg/dL", "1,200") are flagged NORMAL, so no critical alert fires **[verified]** | H · ✅ fixed | 4.C |
| 6 | Critical values: email only, no escalation, no in-app alert, wrong audience for self-booked tests | H · ✅ fixed (wave 2) | 4.C |
| 7 | Video consults bookable and payable, but no video exists **[verified]** | H · ✅ fixed (hidden until Phase 28) | 4.D |
| 8 | X-ray/ECG-only orders can never reach IN_LAB, so they can never be reported **[verified]** | H · ✅ fixed | 4.D |
| 9 | Staff cannot be deactivated, offboarded, re-invited or have credentials reset | H · ✅ fixed (wave 2) | 4.B |
| 10 | Doctor-ordered lab tests (and any lab walk-in) cannot be booked by staff | H · ✅ fixed (wave 3) | 4.D |
| 11 | Home or later-day sample recollection is a dead end | H · ✅ fixed | 4.D |
| 12 | Deactivating a branch or unpublishing a doctor leaves future appointments booked, with no notice | H · ✅ fixed | 4.D |
| 13 | Prescribing ignores recorded allergies; no prescription void; unsigned visits can be completed | H · ✅ allergy check and unsigned-visit rule fixed; prescription void still open | 4.C |
| 14 | No error or not-found pages in any zone; suspended hospitals show raw errors to the public | H · ✅ fixed | 4.F |
| 15 | No offboarding (export, deletion, crypto-shredding); EXPIRED or CANCELLED hospitals cannot reactivate | H · ✅ fixed (wave 4) | 4.H |

---

## 2. Roles and what they can reach

Computed from the module manifests (`defaultRoleGrants` plus nav items):

| Role | Home | Screens in the menu | Observations |
|---|---|---|---|
| PATIENT | /care | Find a doctor, My appointments, My bills, My family, Lab tests, My lab tests, Health record, Prescriptions, Sharing, Record access, Ask us | Complete set; no dashboard; 11 items wrap badly on phones |
| RECEPTIONIST | /desk | Front desk, Patients, Chat requests, lab Worklist | Holds `invoice:read:branch` and `lab_order:read:branch` without matching screens; the lab permission is too powerful (cancel orders, read reports) |
| NURSE | /desk | Front desk only (2 permissions) | Nothing clinical: no vitals or triage; adds nothing over a receptionist |
| DOCTOR | /doctor (goes to Schedule) | My schedule, Appointments, Today's queue, Patients, Lab results, Find a doctor | Home should be the queue |
| LAB_TECH | /lab | Worklist, Pending results, Home collections | Told to acknowledge criticals on a card only the pathologist can load |
| PATHOLOGIST | /lab | Worklist, Pending results | Can enter **and** verify the same result (no second person) |
| PHLEBOTOMIST | /lab/visits | My visits | Cannot print labels for the tubes they collect |
| BRANCH_ADMIN | /admin | Overview, Branches (read), Staff (read), Roles (read), Doctors, Specialties, Schedules, Billing, Messages, Audit, Lab catalog, Home collection, Assistant knowledge, desk screens | Hospital-wide config powers (pricing, doctors, knowledge) and the hospital-wide audit log; cannot invite staff; never exercised by any test |
| TENANT_ADMIN | /admin | Everything (grant-all) | Grant-all also puts doctor-only ("My schedule", "Today's queue") and phlebotomist ("My visits") items in the admin's menu |
| PLATFORM_PRODUCT / APPROVER / SUPPORT | /platform | Hospitals, Plans, Prices, Editions, Modules, Audit | All three see the same menu; support has no tools to act for a hospital |

Permissions only the hospital admin holds: `branch:manage`, `settings:manage`, `staff:invite`, `role:assign`, `role:manage`, `notification:manage`, `plan:read`, `subscription:manage`.

---

## 3. End-to-end flows

### 3.1 Prospect → hospital live (self-serve)

1. ✅ `/pricing` (built from published plans).
   - ⚠️ "Talk to sales" is just a `mailto:` link; no lead is captured.
2. ✅ `/signup`: the address is checked and held for 24 h, and a confirmation e-mail is sent.
   - ❌ No resend or "change e-mail". A typo locks the address for 24 h (`SLUG_TAKEN`).
3. ✅ The confirmation link starts the provisioning saga: database, login, modules, trial and storage. `/signup/status` shows 5 readiness checks.
   - ⚠️ A failure is detected only when someone polls the page after 10 minutes. There is no alert, retry or clean-up, and the half-created hospital keeps its address.
   - ❌ No "your hospital is ready" e-mail.
4. ⚠️ First login.
   - In production, Keycloak's set-password, TOTP and verify-e-mail mail is valid for 3 days and **cannot be re-sent** (re-inviting finds the existing user, so no mail goes out).
   - The owner stays `INVITED` (see 4.A-3).
5. ✅ `/admin/setup`: branding → branch → doctor → hours → bank account → finish.
6. ✅ The first patient books.

### 3.2 Patient: find, book, pay, attend, follow up

1. ✅ `/care` → `/care/doctors`. Search-service handles symptoms and "next available", and falls back to the directory. Then the doctor profile with a slot picker.
2. ✅ Pick a time; signed-out visitors are sent to `/login?next=` with context kept.
   - ✅ OTP login.
   - ❌ No resend code or "change number" control. `OTP_LOCKED` says "request a new one", but there is no way to do so.
3. ✅ `/care/book/[slot]`: the record is created inline on the first booking, then patient (self or family), reason and payment mode.
   - ❌ **VIDEO slots can be booked and paid, but no meeting exists** (Phase 28).
4. ✅ Online: a 10-minute hold, then `/care/pay/[invoice]`, then confirmation. A late payment is auto-refunded.
   - ⚠️ The "confirming" page refreshes every 2 s forever if a consumer lags.
5. ✅ SMS/e-mail confirmation plus reminders 24 h and 2 h before.
   - ⚠️ The e-mail promises a hard-coded "2 hours" cancellation window.
6. ⚠️ Reschedule and cancel from `/care/appointments`.
   - The window shown comes from an environment constant, not the hospital's setting.
   - No confirmation and no refund preview (100% / 50% / 0%).
   - The Reschedule button shows even after the reschedule limit is reached.
   - Rescheduling can switch branch, fee or mode without re-billing.
   - Holds awaiting payment cannot be cancelled.
7. ⚠️ Waitlist.
   - Self only (no family member can be chosen), no "leave waitlist" (the API exists), and "book it now" is not a link.
8. ✅ Visit: check-in, then the queue, then the consultation, then the prescription (SMS plus PDF).
   - ❌ Follow-up date is printed only: no booking and no reminder.
9. ✅ `/care/prescriptions`, `/care/timeline` (family switcher, uploads with virus scan, allergies), `/care/sharing`, `/care/access-log`.
   - ⚠️ The timeline shows only the first 30 items (the API has a next cursor).
   - ⚠️ Lab and report entries are not links; the patient cannot remove their own upload.
   - ⚠️ The patient cannot read their visit notes.
10. ⚠️ Bills: invoice and receipt PDFs. No invoice detail, so refund status is invisible.
11. ⚠️ Profile.
    - No editing or removing a family member (the PATCH API exists).
    - No phone change, account deletion or data export.
    - Hindi is SMS-only: no Hindi e-mails and no Hindi UI.
12. ✅ AI assistant (`/care/assistant`): hospital answers, emergency short-circuit, and "Talk to a person".
    - ⚠️ Signed-in patients only.
    - ⚠️ The desk is not alerted (see 3.3).

### 3.3 Front desk: walk-in to paid visit (RECEPTIONIST, NURSE)

1. ✅ `/desk`: today's board per branch with live updates.
   - ❌ No other days, although the API takes `?date`.
   - ❌ No search by appointment number.
2. ✅ `/desk/patients`: search by phone, MRN or name; register the phone owner, then family members; duplicates refused.
   - ❌ No editing of a patient's details.
   - ❌ No way to register a patient without a phone (unconscious or unknown).
3. ⚠️ `/desk/book`: today only, in person only. ❌ No phone booking for future days.
4. ✅ Check-in gets an atomic token.
   - ❌ No token slip and no waiting-room display.
5. ✅ Collect cash, UPI or card (a reference is required for UPI and card).
   - ❌ No receipt print and no end-of-day cash count.
   - ⚠️ Other desks' boards do not refresh on payment.
6. ⚠️ No-show and "Left": no confirmation and no undo. A late arrival after the automatic no-show sweep cannot check in.
7. ⚠️ Cancel: confirmed visits only, with a fixed reason. ❌ No **reschedule** at the desk, although the API exists.
8. ❌ Refunds: the receptionist has no refund permission. Cash refunds are marked PROCESSED at once, and nothing asks the desk to hand the money back.
9. ⚠️ `/desk/assistant` chat requests.
   - No live refresh, notification or branch filter.
   - **EMERGENCY handoffs wait for someone to reload the page.**
10. ❌ Lab at the desk: no screen. Doctor-ordered tests sit in AWAITING_BOOKING until the patient books them in the app.
11. ❌ Nurse: no vitals or triage. Yet through the API a nurse or receptionist can start or complete any doctor's visit, which blocks the doctor with `DOCTOR_BUSY`.

### 3.4 Doctor: day in the clinic

1. ⚠️ `/doctor` goes to Schedule, not the queue.
2. ✅ `/doctor/schedule`: hours, leave, overlap protection. Leave cancels bookings and refunds 100%.
   - ⚠️ Patients already checked in and walk-ins for that day are not touched.
3. ⚠️ `/doctor/appointments`: read-only, next 7 days, no links to charts.
4. ✅ `/doctor/queue`: call in, start, left, no-show, complete. One visit at a time, live updates.
   - ❌ "Start video visit" has nothing behind it.
5. ⚠️ `/doctor/consult/[appt]`: vitals, notes (optimistic lock), ICD-10, sign (needs a diagnosis), amend, prescription and PDF, lab order, allergies, documents, history.
   - The amend form edits notes only (the API also takes complaint and diagnoses).
   - The form allows 5 medicine rows; the API allows 20.
   - **Finish works on an unsigned visit.**
   - **Prescriptions are not checked against allergies.**
   - No prescription void.
   - A session expiring mid-consult loses typed notes.
6. ✅ `/doctor/patients`: chart by exact MRN, treating-relationship access, break-glass (reason, 4 h, audited, shown to the patient), consents.
   - ⚠️ No "my patients" list.
   - ⚠️ The treating relationship counts NO_SHOW visits and never expires for old encounters.
7. ⚠️ `/doctor/lab-results`: unacknowledged criticals first, then acknowledge.
   - Shows only orders this doctor placed.
   - No escalation and no alert outside this page.
8. ❌ Video consults, referrals, follow-up booking, an in-app inbox, and notifications for new, cancelled or walk-in bookings.

### 3.5 Lab: order → sample → result → report

1. Orders.
   - ✅ The patient books at the lab or at home, online or pay later.
   - ✅ The doctor orders in the consultation; the order waits in AWAITING_BOOKING and the patient gets an SMS to pick a time.
   - ❌ Staff cannot book or schedule for a patient (no walk-ins, paper orders, or patients without the app).
2. ⚠️ `/lab` worklist by branch and day.
   - Defaults to the hard-coded "Sector 44" branch.
   - Does not list doctor orders with no time picked.
3. ✅ Payment at the counter, then collection, which is blocked until paid.
4. ✅ Labels (Code128), collected scan (turnaround clock starts), received scan (IN_LAB).
5. ⚠️ Reject a tube with a reason: a new label and a recollect SMS.
   - **Home recollection is a dead end.**
   - **Recollection on a later day fails** (the order's original date must be today).
   - A tube can be rejected even after the report is published.
6. ✅ `/lab/pending` (overdue first), then `/lab/orders/[id]`: values per parameter, sex-specific ranges, history.
   - ❌ **No numeric validation**: units, commas and text are accepted and can be flagged NORMAL.
   - ❌ Ranges ignore age.
7. ✅ The pathologist verifies, producing a PDF with letterhead and QR that is stored in the patient record; the patient and the doctor are notified.
   - ⚠️ The same person can enter and verify.
   - ⚠️ Verifying is not blocked by unacknowledged criticals.
   - ⚠️ An amendment whose PDF storage fails leaves new values under the old PDF, with no way to retry.
8. ✅ Home collection.
   - Areas, then dispatch (with a check that a phlebotomist can't be in two homes at once), then on my way / arrived / take payment / scan tubes, then hand-over at the bench.
   - A missed visit leads to a free rebooking.
   - ❌ Phlebotomists cannot print labels.
   - ❌ The lab cannot fix a visit stuck EN_ROUTE.
   - ❌ The phlebotomist list never shrinks (role changes and leavers are ignored).
9. ❌ X-ray/ECG-only orders: no tubes, so never IN_LAB, so never reported **[verified]**.
10. ❌ Not built:
    - catalog editing beyond price, preparation and on/off (no new tests, ranges, critical limits, turnaround or lab-counter windows);
    - outsourced tests, QC, delta checks, analyser interface, STAT priority;
    - partial cancellation.

### 3.6 Hospital admin and branch admin

1. ✅ Setup guide, branding (logo as a URL), settings within plan bounds, role editor (guardrails, preview, history), custom domain (TXT verification), schedules, AI knowledge.
2. ⚠️ Branches: create and activate only.
   - ❌ No edit of name, address or time zone; no time zone on create (fixed to IST); an invalid zone is not rejected.
   - Reactivating a branch skips the plan limit.
3. ❌ Staff: invite only, one role, no branch.
   - Nothing moves a member from INVITED to ACTIVE.
   - No deactivate, edit, resend invite, password or MFA reset.
   - Removing roles leaves the Keycloak login and organisation membership in place.
4. ⚠️ Doctors.
   - Unpublishing leaves future bookings and the doctor's login active.
   - Re-publishing skips the doctor limit.
   - Editing a doctor silently drops links to inactive branches.
5. ⚠️ Patient billing: the day list is fixed to IST.
   - No branch filter, date range, cash-up, export or void.
   - Refunds work and are capped.
6. ⚠️ Payment account: the bank account can be overwritten at any time with no re-authentication, notice or history (payout hijack risk once Razorpay Route is real).
7. ⚠️ Messages: no placeholder validation, preview or reset for templates; the log shows the last 100 only, with no resend.
8. ⚠️ Audit log: covers record access only. **Admin actions are not audited**: refunds, invites, role grants, branch, settings, template, price and payout changes.
9. ⚠️ Lab catalog: price, preparation and on/off only. Home windows: the API exists, but there is no UI.
10. ⚠️ Read-only or suspended modules: config screens and lists disappear, because they require `:manage`.
11. ❌ Reports and analytics, data export, closing the account.
12. ⚠️ Branch admin.
    - Hospital-wide config powers and the hospital-wide audit log.
    - Typing the URL of a page they can't use gives an unhandled 403.
    - **No test exercises this role.**
13. ⚠️ Escalation.
    - Anyone with `staff:invite` can invite a TENANT_ADMIN.
    - Anyone with `role:assign` can grant TENANT_ADMIN.
    - A custom role with `role:manage` can add any permission to itself.

### 3.7 Hospital subscription (owner, `/account`) and the hospital lifecycle

| Step | State | Note |
|---|---|---|
| Trial → card → ACTIVE (prorated) | ✅ | E-mails sent: trial ending, trial converted |
| Trial ends with no card → EXPIRED | ❌ | No notice; adding a card does not reactivate; plan change refused |
| ACTIVE → PAST_DUE → GRACE → SUSPENDED (read-only) → paid → ACTIVE | ✅ | ⚠️ An offline payment that reactivates the hospital sends no notice |
| SUSPENDED 60 days → CANCELLED; cancel at period end | ⚠️ | No notice, no reactivation, no export |
| Sales-led (OFFLINE) renewal | ⚠️ | Invoice issued silently: no e-mail, never past due, unpaid invoices pile up |
| Upgrade now (prorated) / downgrade at period end | ✅ | |
| Deletion | ❌ | Status only. Database, buckets and data keys are kept; no export, no crypto-shredding |

Two separate state machines, tenant status and subscription status, can disagree. The tenant status has no screen.

### 3.8 MediCare staff (platform console)

1. ✅ Plan builder → submit → second person approves (impact preview, NEW_ONLY or MIGRATE_NOW) or rejects. All audited.
   - ⚠️ The approver is not notified.
   - ⚠️ MIGRATE_NOW does not notify hospitals, and the price lands at renewal.
2. ⚠️ Hospitals list: slug, plan and add-ons only. No name, owner, billing status, search or paging.
3. ✅ Hospital page: contract, module states, limits, simulator, move plan, overrides, history, billing, offline payment.
   - ⚠️ Overrides and coupons are single-person with no expiry; coupons cannot be deactivated.
   - ⚠️ A console plan move is undone at renewal by the hospital's own scheduled downgrade.
4. ❌ Missing:
   - support access to a hospital (time-limited access the hospital approves, or impersonation);
   - creating, suspending, deleting or reactivating a hospital; extending a trial;
   - credit notes or voids; switching a hospital between offline and card payment;
   - a list of signups and failed signups; resending an owner's invite.

---

## 4. Gaps by theme (deduplicated)

### 4.A Production blockers

| # | Gap | Evidence | Sev | Fix |
|---|---|---|---|---|
| A-1 | subscription-service always wires `SimulatedCards`, which throws when not in dev **[verified]** | `subscription-service/src/app.module.ts:20`, `billing/gateway.ts:38` | H | A Razorpay Subscriptions or Mandate adapter selected by env; until then a "manual only" mode |
| A-2 | No SMS provider: OTPs and notifications always go to `@sms.medicare.local` **[verified]** | `iam-service/src/patients/sms.ts:23`, `notification-service/src/channels/channels.ts:41` | H | MSG91/Twilio adapter with DLT templates |
| A-3 | Staff stay `INVITED` forever outside dev. Staff e-mail requires ACTIVE, and so does iam's membership lookup **[verified]** | `iam staff.service.ts:46`; no `UPDATE staff_members`; `dispatcher.job.ts:106`; `staff.controller.ts:34` | H | Mark ACTIVE on first login (Keycloak event, or the first `/me` call) |
| A-4 | Signup and OTP mailers ignore SMTP user, password and TLS | `signup.service.ts:26`, `sms.ts:12` | H | One shared SMTP factory |
| A-5 | Simulated: Razorpay Route (payout accounts), ClamAV (tested against a fake only), Gemini/Vertex (never called), KMS (env master key) | see section 5 | M–H | Real adapters, plus an integration run in staging |

### 4.B Security and access control

| # | Gap | Evidence | Sev | Fix |
|---|---|---|---|---|
| B-1 | `:branch` permissions are hospital-wide: `user_roles.branch_id` is stored but never read when working out permissions; no service filters by branch; the role screen can't set a branch **[verified]** | `entitlements.service.ts:273-275`; `billing.controller.ts`; `queue.service.ts`; `lab.service.ts`; `roles/actions.ts` | H | Return permission → branchIds in Capabilities; enforce in scheduling, billing, lab, handoffs; branch picker on role grants; default the UI to the user's branch |
| B-2 | No staff offboarding, deactivation, resend, or password/MFA reset; removing roles keeps the login, organisation membership and sessions | iam `staff.controller.ts`; `keycloak-admin.ts` | H | Deactivate (org removal, disable, log out sessions), resend invite, reset credentials |
| B-3 | Privilege escalation through invite, role assignment or role editing (anyone can grant TENANT_ADMIN or permissions they don't hold) | `staff.controller.ts:10-14`; `entitlements.controller.ts:57-62`; `config.service.ts:132` | M | Only grant roles whose permissions the actor holds; only owners assign TENANT_ADMIN |
| B-4 | Default grants too wide: branch admin can price the whole hospital's lab catalog, edit every doctor and read the hospital-wide audit log; receptionist's `lab_order:read:branch` allows cancelling orders and reading report PDFs; desk staff can start or complete any doctor's visit through the API | manifests; `lab.service.ts:327`; `results.controller.ts:56`; `queue.service.ts:146` | M | Split the permissions (`lab_order:cancel`, `report:read`, `visit:manage`); trim the defaults |
| B-5 | Payout bank account changeable at any time with no step-up, notice or history | `payment-account.service.ts:44-56` | H (once real) | Re-authentication or MFA, owner e-mail, history, payout hold after a change |
| B-6 | Raw card numbers pass through the BFF and subscription-service | `zone-account/lib/actions.ts:20`; `gateway.ts:14` | M | Hosted checkout or mandate only |
| B-7 | Rate limits: the signup per-IP limit can't see the real client IP; the gateway limit is keyed on a header the client controls; no per-IP or per-hospital OTP cap (SMS pumping billed to the hospital) | `bff/src/index.ts:60`; `signup.controller.ts:34`; `kong.yml` | M | Forward and trust the client IP only from the gateway; limit per user and per IP; OTP caps per IP and per hospital |
| B-8 | Admin actions not audited (refunds, invites, role grants, settings, templates, prices, payout account) | no `audit.record` in those services | M | Audit events plus a "Configuration" filter on `/admin/audit` |
| B-9 | No NetworkPolicies; OpenSearch has no auth; one shared `INTERNAL_API_TOKEN`; logout is a GET (CSRF-able) and sends no `id_token_hint` | deploy charts; `opensearch.yaml`; `auth/logout/route.ts` | M | NetworkPolicies, per-service identity, logout via POST |

### 4.C Clinical safety

| # | Gap | Evidence | Sev | Fix |
|---|---|---|---|---|
| C-1 | Values with units or commas ("450 mg/dL", "1,200") or qualitative text ("Trace", "1+") are flagged NORMAL, with no critical alert; numeric parameters accept free text **[verified]** | `diagnostics-service/src/lab/flags.ts:27-30`; `results.service.ts:88-90` | H | Mark each parameter numeric or qualitative; reject or normalise input; plausibility limits; picklists for qualitative results |
| C-2 | Critical values: e-mail to the ordering doctor only; no escalation, no SMS or push, no in-app banner; the lab can't see whether the doctor acknowledged; self-booked criticals notify nobody; no "communicated to / read-back" record | `results.service.ts:115-124,245-273`; `planner.service.ts:143` | H | Escalation job (pathologist → on-call → branch admin), SMS, a doctor-zone banner, an "acknowledgements outstanding" lab view, read-back fields |
| C-3 | Prescribing ignores recorded allergies; free-text drugs; prescriptions can't be voided | `records.service.ts:223-243` | H | Allergy check with an override reason, drug master, void with audit (drug interactions are planned for Phase 25) |
| C-4 | A visit can be finished while the note is unsigned; no "unsigned notes" list | `queue.service.ts:117-122` | H | Block or warn on Finish; worklist of unsigned notes |
| C-5 | Reference ranges ignore age; unknown or "OTHER" sex uses the first (often the male) range | `flags.ts:7-11` | M | Age bands; for unknown sex use the general or widest range |
| C-6 | No second person: a pathologist can verify their own entry; verify isn't blocked by unacknowledged criticals | `results.service.ts:146-152` | M | Optional per-hospital rule plus a warning |
| C-7 | A tube can be rejected after results are entered or published, which hides the report from the patient | `lab.service.ts:546-549` | M | Reject only before results are entered; corrections go through amendment |
| C-8 | Doctors only see their own lab orders, and previous or pending labs aren't shown in the consultation | `results.service.ts:284` | L | Per-patient lab history in the consultation |

### 4.D Flow dead ends

| # | Gap | Evidence | Sev | Fix |
|---|---|---|---|---|
| D-1 | Video consults can be created, booked and paid, but no meeting exists **[verified]** | `schedule-ui/src/index.tsx:72`; `doctor queue/page.tsx` | H | Hide VIDEO until Phase 28, or add a meeting-link field now |
| D-2 | X-ray/ECG-only lab orders can never be reported **[verified]** | `lab.service.ts:249,534`; `results.service.ts:133` | H | A "performed" action for orders with no tubes, or hide those tests until there is a radiology flow |
| D-3 | Staff can't book or schedule lab tests for a patient (paper orders, walk-ins, patients without the app) | `lab.service.ts:261,276`; no desk lab screen | H | `lab_order:create:branch` plus a "book now" screen in the desk and lab zones |
| D-4 | Recollection: home samples dead-end; lab recollection works only on the original day | `lab.service.ts:280,498,508`; `home.service.ts:13` | H | Reopen as AWAITING_BOOKING, or allow a counter collection; skip the date check for replacement tubes |
| D-5 | Deactivating a branch, unpublishing a doctor or removing a doctor's branch leaves future bookings, with no warning or notice | `schedule.service.ts:75-83` | H | Show affected appointments; cancel, refund and notify (reuse `cancelForLeave`) |
| D-6 | An amendment whose PDF storage fails leaves new values under the old PDF; retrying gives `NOTHING_TO_AMEND` | `results.service.ts:156-199` | H | Stage the values with the new report row, or allow "republish current values" |
| D-7 | EXPIRED or CANCELLED hospitals can't reactivate (owner or support) | `billing.service.ts:357,426` | H | Resubscribe flow plus a console action |
| D-8 | Signup: no resend or change of e-mail; owner invite can't be re-sent; failed provisioning has no alert, retry or clean-up | `signup.service.ts:155-160`; `keycloak-admin.ts:139` | M | Resend endpoints, saga monitor and alert, console list of signups |
| D-9 | OTP: no "resend code" or "change number" | `login/otp-form.tsx`; `login/actions.ts:11` | M | Buttons that post `restart`, with a cooldown |
| D-10 | Home visit stuck EN_ROUTE or ARRIVED can't be fixed by the lab; overdue unassigned visits aren't flagged | `home.service.ts:136`; `lab.service.ts:331` | M | Dispatcher can reassign, mark missed or cancel; overdue alert |
| D-11 | A downgraded lab module freezes in-flight orders (no results, verify or refund) | entitlements-sdk read-only rule; `tat.job.ts:30` | M | Allow completion steps for orders created before the downgrade |
| D-12 | No-show is final (no undo); a late arrival after the sweep can't check in, and the online payment stays on the NO_SHOW | `queue.service.ts:125-142` | M | Same-day undo; a late-arrival flow that carries the payment over |
| D-13 | Waiting for payment: the patient can't cancel the hold; the "confirming" page never stops refreshing | `appointments/page.tsx:30`; `pay/[invoiceId]/page.tsx:32` | L | Cancel next to "Pay now"; stop after N tries with a "we'll SMS you" message |

### 4.E Missing screens for existing APIs (cheap wins)

| # | API | Missing screen |
|---|---|---|
| E-1 | `POST /appointments/:id/reschedule` (staff) | Desk "Move" action |
| E-2 | `GET desk/board?date=`, slots for other days | Desk date picker and future booking |
| E-3 | `GET /invoices/:id/pdf` (`invoice:read:branch`) | Desk receipt print and "collections today" |
| E-4 | `PATCH /branches/:id` (name, address, time zone) | Branch edit (with a time zone select) |
| E-5 | `PUT admin/home-windows/:branchId` | Home collection windows editor |
| E-6 | `PATCH /me/dependents/:id`; `DELETE /waitlist/:id` | Patient: edit family member, leave waitlist |
| E-7 | Timeline `next` cursor; patient document delete | "Older" paging; remove own upload |
| E-8 | `InvoiceDetail.refunds` | Patient invoice detail with refund status |
| E-9 | Amend API accepts complaint and diagnoses | Doctor amend form for diagnoses |
| E-10 | `PATCH` lab results / tests | (no API) catalog editor for ranges, critical limits, turnaround, packages |

### 4.F UX and resilience

| # | Gap | Sev | Fix |
|---|---|---|---|
| F-1 | No `error.tsx`, `not-found.tsx` or `global-error.tsx` in any zone: raw Next error pages, no way back | H | Branded error and not-found pages per zone, plus a friendly "no access" page instead of an unhandled 403 |
| F-2 | Suspended hospital: patients get no notice; Book and Waitlist stay visible; public pages likely error (anonymous GETs to read-only modules are refused) | H | A patient-facing "online booking paused" notice; gate buttons on permissions; let the public directory stay readable |
| F-3 | The cancel window shown comes from an environment constant, while enforcement uses the hospital's setting; e-mails say "2 hours" | M | Return the hospital's cutoff to the UI and to templates |
| F-4 | No patient home dashboard (upcoming visits, unpaid holds, tests waiting for a time); the 11-item menu wraps on phones | M | Summary cards on the patient home; collapsible menu on phones |
| F-5 | Session expiry loses work (consultation notes); server actions redirect to `/login` with no `next`; PDF routes return plain-text 401 | M | Autosave or draft for notes; keep `next`; redirect from PDF routes |
| F-6 | Hard-coded IST and "Sector 44" (billing day list, lab default branch, home visits, PDFs) | L | Use the branch time zone; default to the first or the user's branch |
| F-7 | No printing: token slips, wristbands, desk receipts, home-kit labels | L–M | Printable routes |
| F-8 | Doctor home is the schedule; appointments don't link to the chart; MRN-only search | L | Home → queue; links; recent patients |
| F-9 | Hindi exists only for SMS | L–M | Hindi e-mails; plan `@mc/i18n` |

### 4.G Notifications not sent today

| Who | Missing notification |
|---|---|
| Patient | Lab cancelled or expired; payment hold expired; prep or fasting reminder before a lab visit (promised in HLD.md); follow-up reminder; refund completed; "online booking paused" |
| Doctor | New, cancelled or walk-in bookings; daily agenda; critical-value escalation by SMS or push; break-glass review |
| Desk | New chat request (especially EMERGENCY); cash refund to hand back |
| Lab | Turnaround breach (`labTatBreached` has no consumer); critical on a self-booked test |
| Hospital owner | "Hospital ready"; EXPIRED and CANCELLED; offline invoice issued or overdue; plan or modules changed by MediCare; payout account changed |
| MediCare staff | Plan waiting for approval; rejected or published; failed signups; DLQ events |

### 4.H Operations, compliance and data

| # | Gap | Sev | Fix |
|---|---|---|---|
| H-1 | No offboarding: data export, deletion schedule, crypto-shredding of data keys; patients can't export or delete their own data (DPDP) | H | Export bundle per hospital and per patient; purge job; destroy `tenant_keys` |
| H-2 | No reports or analytics for hospitals (revenue, utilisation, no-shows) | M | Basic reports (Phase 29 analytics) |
| H-3 | No metrics, tracing or alerting; `/health` always returns 200 and is used for both readiness and liveness | M | OpenTelemetry, Prometheus, alerts; real readiness checks (Phase 30) |
| H-4 | DLQs have no consumer, alert or replay tool | M | DLQ dashboard and alerts; `mc events replay` |
| H-5 | `outbox`, `processed_events` and soft-deleted documents grow forever (PII in event payloads) | M | Retention and purge jobs |
| H-6 | CI runs only the assistant, tenancy and race suites: no Playwright, no billing, console or onboarding suites, no dependency or image scanning | M | Add those suites plus Trivy and CodeQL |
| H-7 | Platform console: support can't act for a hospital; no create, suspend, delete or reactivate; no trial extension or credit note; overrides and coupons have no approval or expiry; console plan moves get undone at renewal | M | Phase 31 support access, plus console actions and approval rules |
| H-8 | Two status models (tenant and subscription) that can disagree, and the tenant status has no screen | L | One status shown in the console |
| H-9 | Test-data pile-up breaks end-to-end runs (seen in this review): leftover doctors, full days for Dr. Asha Rao, Keycloak redirects | L | Clean-up in every spec (started: p6, p8), periodic dev reset |

---

## 5. Simulated vs real integrations

| Integration | Local | Staging config | Real adapter |
|---|---|---|---|
| Patient payments (Razorpay orders and webhooks) | Simulator | `razorpay` | ✅ built, never run with keys |
| Razorpay Route (hospital payouts) | Simulated | none | ❌ |
| SaaS recurring cards | `SimulatedCards` | none | ❌ (service crashes outside dev) |
| SMS (OTP and notifications) | Mailpit | falls back to Mailpit | ❌ |
| E-mail | Mailpit | SMTP | ⚠️ notifications yes; signup and OTP mailers have no auth |
| Virus scan | Dev EICAR scanner | in-cluster clamd | ⚠️ tested against a fake only |
| Gemini / Vertex (assistant) | Offline dev provider | Vertex AI | ⚠️ built and typechecked, never called |
| Key wrapping | `MC_MASTER_KEY` | Secret Manager env | ❌ no KMS |
| Object storage | MinIO | GCS (S3 API) | ✅ (unverified on GCS) |
| Search | OpenSearch | single node, no auth | ✅ |
| Custom-domain TLS | `*.localhost` | none | ❌ |
| WhatsApp, video, captcha | none | none | ❌ |

---

## 6. Recommended plan

The review changes the order of work. Before Phase 23 (assistant booking tools), these should be done.

**Wave 1: correctness and safety (about 1–2 weeks).** All of it is self-contained, and most items are small:
- C-1: numeric validation and normalisation of lab values.
- C-4: no finishing an unsigned visit.
- C-3: allergy check on prescriptions.
- C-7: tube rejection limited to before results are entered.
- D-1: hide video.
- D-2: "performed" action for tests with no tubes.
- D-4: recollection paths.
- D-5: cancel and notify when a branch or doctor is removed.
- D-6: amendment staging.
- A-3: staff become ACTIVE on first login.
- A-4: shared SMTP factory.
- F-1: error and not-found pages.
- F-2: suspended-hospital patient notice.
- F-3: real cancel window.
- B-3: escalation guard on role grants.

**Wave 2: access control and staff lifecycle.** ✅ Done 2026-10-30 (see §8).
- B-1: branch scoping end to end, plus Playwright and API tests for BRANCH_ADMIN and NURSE.
- B-2: staff offboarding, resend and reset.
- B-4: split permissions and trim default grants.
- B-8: audit of admin actions.
- Nurse vitals and triage.
- C-2: critical-value escalation.
- Desk alerts for chat requests.

**Wave 3: front-desk and lab completeness.** ✅ Done 2026-10-30 (see §8).
- E-1 to E-3: reschedule, future dates and receipts at the desk.
- D-3: staff booking of lab tests.
- Cash refund hand-back.
- D-12: no-show undo.
- D-10: home-visit dispatcher fixes.
- E-10: lab catalog editor.
- E-4 and E-5: branch edit with time zone, home windows editor.
- E-6 to E-8: patient-side screens for existing APIs.
- The missing notifications (4.G).

**Wave 4: production readiness (alongside M7).** ✅ Done 2026-10-30 for everything that needs no provider account (see §8); the real-provider runs wait for keys.
- A-1: SaaS recurring adapter.
- A-2: SMS provider with DLT templates.
- B-5: payout account protection.
- B-6: hosted card capture.
- KMS.
- H-3 and H-4: observability and DLQ tooling.
- H-6: CI suites.
- H-1: offboarding and export.
- D-7: reactivation.
- H-7: support access and console actions.
- Then the real-provider runs (Razorpay, Route, ClamAV, Gemini).

---

## 8. Fix log

### Wave 1: done 2026-10-25

Verified by `mc test gaps`, with each fix checked the way a user meets it, plus the full regression run.

| Gap | What changed |
|---|---|
| C-1 lab values | `parseValue` before storing and flagging. The expected unit is accepted and dropped ("450 mg/dL" → 450, CRITICAL_HIGH); thousands separators ("1,200") and decimal commas ("14,2") are handled. Text for numeric parameters, a different unit, and implausible values (platelets "250000", a unit mix-up) are refused. An unreadable value can never be flagged NORMAL (safety net), and "Trace" / "2+" are ABNORMAL. |
| C-7 late rejection | A tube can't be rejected once results are entered or published; corrections go through amendment. |
| C-4 unsigned visits | Completing a visit with an open note is refused (`NOTE_NOT_SIGNED`; records-service is asked, and the check fails open if records is down). The doctor can deliberately "finish, sign the note later". "Unsigned notes" list on the doctor's queue. |
| C-3 allergy check | Prescriptions are checked against the patient's recorded allergies, by name and drug class (penicillins, cephalosporins, sulfa, NSAIDs, macrolides, quinolones…). A clash is refused unless the doctor gives a reason; the reason is stored and audited, and the form comes back filled in. Allergies that can't be read also need a reason. Medicine rows on the form: 5 → 8. |
| D-1 video | Video hours can't be added, video slots aren't offered or booked or used for rescheduling, and the video options are gone from the screens (`VIDEO_CONSULTS_ENABLED` turns them back on in Phase 28). |
| D-2 X-ray / ECG | "Patient seen: write the report" on the worklist, for orders with no tubes: they move to IN_LAB and get a report. |
| D-4 recollection | A replacement tube can be collected at the counter on any day, home orders included. The patient can pick a new time for a rejected order ("pick a time" link; no extra charge). |
| D-6 amendment | If values changed after the last published report (its PDF failed to store), the amendment republishes them instead of `NOTHING_TO_AMEND`. |
| D-5 doctor or branch gone | Unpublishing a doctor, deactivating a branch, or removing a doctor's branch cancels the affected future bookings (hospital-cancelled, full refund, patients told; same path as doctor leave). Admins see "N upcoming appointments" and must tick a box first. |
| F-3 cancel window | Patients see the hospital's own cutoff; the confirmation e-mail uses `{{cutoff}}` (migration for untouched templates). |
| F-1 error pages | Branded `error`, `not-found` and `global-error` pages in all 8 zones (`@mc/ui/errors`), with a way home and a reference for support. |
| F-2 booking paused | Patient home, doctor search, doctor profile and booking show "Online booking is paused at this hospital" when the module is off or read-only, instead of erroring. Book and Waitlist are hidden. |
| A-3 staff status | The first sign-in moves an invited member to ACTIVE (web callback → iam). Staff are reachable for e-mail unless disabled. |
| A-4 SMTP | One `smtpOptions()` (auth and TLS) for notifications, signup and the dev SMS mailer. Staging secrets wired for iam and tenant. |
| B-3 escalation | Roles can be given (invite or assign) only if the giver holds all their permissions. Only a hospital admin can make a hospital admin. Role editors can add only permissions they hold. Unknown roles are refused before a login is created. |

Also fixed during the review, before wave 1: staff sign-in failing once Keycloak tokens grew past the cookie limit (iam now removes the `web-origins` scope and sweeps old redirects).

### Wave 2: done 2026-10-30

Verified by `mc test wave2` (45 checks), the tenancy leak test (now 1015 checks, with the new routes) and the full regression run.

| Gap | What changed |
|---|---|
| B-1 branch scoping | Capabilities now say which branches each `:branch` permission was given for (`branchScopes`, and `branchIds` for the person). The SDK guard refuses a `branchId` outside them (`403 OUTSIDE_BRANCH`). Records found by id (appointments, invoices, lab orders, samples, results, reports, home visits, triage) answer "not found" at another branch. Lists are filtered: the billing day, the lab's critical values, a doctor's queue, and the doctors an admin may schedule. The desk, lab and billing screens offer only the person's own branches, theirs first. The staff page gives roles per branch, and someone who works at some branches can give roles only at those. |
| B-2 offboarding | Staff page per person, with these actions. **Deactivate:** every role removed at once, the person leaves the hospital's Keycloak organization, their sessions end, and the login is disabled unless they work at another hospital. **Reactivate.** **Resend invite:** only before the first sign-in, at most once every 2 minutes. **Reset password and/or authenticator app:** an e-mail link; sessions end; the admin never sees the password. A new permission, `staff:manage:tenant`, is held by hospital admins. Nobody can act on their own account, and nobody can act on someone with roles they could not give themselves. The last hospital admin is kept. |
| B-4 permissions | New permissions: `lab_order:cancel:branch`, `report:read:branch`, `visit:manage:branch`. Only the visit's doctor (or holders of `visit:manage`) can start or finish a visit, so the desk no longer causes `DOCTOR_BUSY`. Branch admins no longer get doctor editing, lab prices, home areas or the hospital-wide audit log. The desk no longer gets report PDFs or lab cancellation. Template changes now also remove grants from roles the hospital has not customised. |
| B-8 admin audit | Admin changes are written to the audit log with purpose ADMIN; they appear under "Configuration only" on `/admin/audit`. Covered: staff invites, deactivation, reactivation and resets; role grants; settings; the role editor; branches; doctors; lab prices; home collection; message templates; refunds; the payout account; branding; domains; the subscription; the AI knowledge base. Staff actions are recorded in the same transaction as the change. The others use `@AdminAudited`, which records after success and retries if the audit log is down. |
| Nurse vitals | After check-in, a nurse records vitals, a priority (routine / urgent / emergency) and the complaint (encrypted). This happens on the desk board ("Vitals"), only at the nurse's own branches. The doctor's queue shows the priority. When the doctor opens the note, it starts with the vitals and complaint. Once the visit has started, vitals go in the note. Permission `vitals:record:branch` is given to NURSE. |
| C-2 critical values | Unacknowledged critical values escalate every 15 minutes (`CRITICAL_ESCALATE_MINUTES`): first the ordering doctor, then the branch's pathologists, then on-call at the branch (`critical:escalation:branch`, held by branch admins). Each level is e-mailed. Self-booked tests go straight to the pathologists; before, nobody was told. The new lab page "Critical values" lists outstanding ones. The lab can record "phoned through to X" with a read-back, which stops the escalation. The doctor's queue shows a red banner. Staff get e-mail only, because there is no staff SMS channel yet. |
| Desk chat alerts | Every desk board shows a banner when patients are waiting for a call back. Emergencies are in red and listed first, and the browser tab shows the count. It refreshes every 20 seconds. The banner is in-app only: the assistant service has no event outbox yet. |

### Wave 3: done 2026-10-30

Verified by `mc test wave3` (31 checks), the tenancy leak test (1045 checks) and the full regression run.

| Gap | What changed |
|---|---|
| E-1 move a booking | Desk "Move" on a booked visit: pick a day and a free time with the same doctor; the payment travels with it. Staff can move only to branches they work at. |
| E-2 other days | Desk board and booking have day chips (today and the next week or two). A later day offers times only, with no walk-in and no check-in. |
| E-3 receipts | "Receipt" next to paid visits on the board. New "Collections" page: the day's totals, the invoices with receipts, and refunds to hand back. |
| Cash refund hand-back | Refunds of counter payments (cash, UPI QR, card machine) wait in `HAND_BACK` and are listed on Collections. "Handed back" completes them: the invoice is updated and the patient is told. Before, they were marked done at once. |
| D-12 no-show | A no-show of today can be checked in ("Arrived late: check in"). It keeps the slot and the payment, and the timeline updates. |
| D-3 staff lab booking | New permission `lab_order:create:branch` (receptionist, lab tech, branch admin). "Book tests" in the lab zone: find the patient, pick tests and a time (the slot running now is allowed for a patient who is there), pay at the lab. The same page gives a time to tests a doctor ordered and to rejected samples. The desk patient list links to it. Lab techs can now look patients up (`patient:register:branch`). |
| D-10 dispatcher | Reassign a visit that is on the way or at the door, as long as no tube has been collected. "Cannot visit" closes a visit, and the patient is asked to pick a new time. Overdue visits are flagged on the board. |
| E-10 catalog editor | Per test: reference ranges (per sex), critical limits (checked to lie outside the normal range), turnaround and fasting. Per package: which tests it contains. |
| E-4 branch edit | Branch page with name, address and time zone. The time zone is validated against IANA zones. |
| E-5 home windows | Home visit times can be edited per branch (they were read-only). |
| E-6 to E-8 patient | **Family:** edit a family member's name, date of birth and relation. **Waitlist:** leave it. **Timeline:** "Older entries" paging, and remove your own uploads. **Bills:** a bill page with payments and each refund's status, including "collect it at the hospital counter". |
| 4.G notifications | **Patients:** lab tests cancelled or expired; appointment released because the payment was not completed; a preparation reminder 12 hours before a lab visit with fasting or preparation (replaced if the time changes, dropped if cancelled); a follow-up reminder the day before the date on the prescription. **Doctors:** the day's list each morning (7 AM at the branch, `AgendaJob`), and same-day bookings and cancellations by e-mail. **Lab:** turnaround breaches e-mailed to the branch's result-entry staff. |

### Wave 4: done 2026-10-30 (everything that needs no provider account)

Verified by `mc test wave4` (48 checks), unit tests for the adapters, the tenancy leak test (1086 checks), the full API regression and Playwright.

| Gap | What changed | Still needs |
|---|---|---|
| A-1 SaaS payments | subscription-service chooses its gateway with `SAAS_PAYMENTS`. `simulated` in development; `manual` (bank transfer, support records payments) elsewhere, so it no longer crashes outside development. `razorpay` is refused with a clear message until it is built. | The Razorpay recurring adapter (live keys) |
| B-6 hosted card capture | Cards are entered on the gateway's hosted page; locally, a simulated one at `/api/subscription/v1/sim-gateway`. The result is confirmed server to server. MediCare's API and the account zone never receive card numbers (`PUT account/card` is gone). The return address must be on the hospital's own site. | — |
| B-5 payout account | Replacing the bank account needs a 6-digit code e-mailed to the person (iam step-up, valid 10 minutes, one use, rate-limited). Every change is kept in a history. All owners are e-mailed. Payouts to the new account are held for 48 hours (`PAYOUT_HOLD_HOURS`). | Live Route onboarding (Razorpay) |
| D-7 reactivation | An EXPIRED or CANCELLED hospital resubscribes from `/account`: card on file, old invoices first, a new prorated period. Support can do the same from the console, also by bank transfer. | — |
| H-1 offboarding | `mc tenant export <slug>`: a database dump plus every document, with a manifest; it works for deleted hospitals too. `mc tenant purge <slug> --confirm <slug>`: only DELETED hospitals, only after `PURGE_AFTER_DAYS` (30). Documents and search indexes are removed, data keys destroyed (crypto-shredding), and the database is dropped. Patients get "Download my data" (JSON) on their profile. | The purge has **not been run** (it was blocked as irreversible); its rules are unit-tested. Patient erasure requests (medical records have legal retention). |
| KMS | Key wrapping is a port (`KEY_WRAPPER`). `local` uses MC_MASTER_KEY, with MC_MASTER_KEY_PREVIOUS for master key rotation; `gcp-kms` uses Cloud KMS via workload identity. `mc keys rotate <slug>` adds a new data key version (old ciphertexts keep decrypting). `mc keys rewrap` moves every data key to the current master key. | A run against real Cloud KMS. Other replicas pick up a rotated key version on restart. |
| A-2 SMS | Shared SMS provider (`SMS_PROVIDER`): `mailpit` locally, or `msg91` (Flow API with DLT template ids and variables by name, tested against a fake). SMS templates carry their DLT and provider template ids (admin Messages page). Unregistered messages are skipped with a clear reason. Login codes use `MSG91_OTP_TEMPLATE_ID`. | An MSG91 account and DLT registration |
| H-3 observability | `/health/live` and `/health/ready` (database and Redis; 503 takes the instance out of the load balancer) back the Kubernetes probes. Prometheus `/metrics` runs on its own port (service port + 5000; 9464 in the cluster), never through the gateway: request latency by route template, outbox backlog, published events, dead-lettered events, retention. A PrometheusRule (`monitoring.enabled`) holds five alerts. | Tracing (OpenTelemetry), dashboards |
| H-4 DLQ | `mc events dlq` counts dead-lettered events per topic and groups them by consumer, type and error. `mc events replay <topic> [--consumer] [--since]` sends them back; consumers dedupe, so this is safe. An alert fires on new dead letters. | — |
| H-5 retention | The relay removes published outbox rows after 7 days and dedupe records after 30, hourly. | Purging soft-deleted documents |
| H-6 CI | A `security` workflow runs CodeQL, `pnpm audit` (high and above) for both apps, and a secret scan, weekly too. The manual integration job seeds the demo hospitals and runs all API suites. Upgrading nodemailer 7 → 10 cleared four high advisories. | Playwright in CI |
| H-7 console | Support can extend a trial (to at most 60 days ahead), add credit notes (taken off the next invoice), take a hospital offline and back, delete it (the slug must be typed), and reactivate it. All of these are in the platform audit log with the reason. | Support access ("act as", Phase 31); approvals and expiry for overrides and coupons |

Not in wave 3, and closed since: E-9 and the 4.G owner and MediCare staff notifications (wave 5, below); wave 4 (above).

### Wave 5: remaining smaller gaps, done 2026-10-31

Verified by `mc test wave5` (15 checks), `w5-amend.spec.ts` (Playwright), unit tests for `clientIp` and trace scrubbing, and the full regression with tracing on (2026-10-31): static checks pass; the tenancy leak test passes (1086 checks, 0 leaks); 16 of 21 API suites pass (billing failed once on timing and passed on rerun); Playwright 53/54. Every remaining failure (`assistant`, `plans`, `onboarding`, the wave2 desk-alert count, the wave5 "ready" check, `p22-assistant.spec.ts`) comes from one configuration problem: the restarted stack picked up a Gemini API key that Google rejects (401), so the assistant called Gemini instead of the offline dev model. Turning on the AI module (which seeds embeddings) then fails, and that is what `plan set` waits on. Rerun them with `LLM_PROVIDER=dev` or a valid key.

| Gap | What changed | Still needs |
|---|---|---|
| E-9 amending diagnoses | The doctor's amend form on a signed visit edits the chief complaint, notes and diagnoses (keep or remove each, add up to two, pick the primary) with a reason. Only changed fields are sent; the amendment keeps the before and after. | — |
| 4.G owner notices | The hospital owner is e-mailed when the subscription expires, is cancelled or is reactivated, when a bank-transfer invoice is issued, when MediCare changes the plan, and when a hospital from self-serve signup is ready. | — |
| 4.G MediCare staff notices | `subscription.staff_notice` reaches MediCare staff by permission (HQ account): plan versions waiting for approval, published or sent back; failed signups (`customer:manage:tenant`), so "our team has been told" is now true. A sweep in tenant-service settles signups every 30 s, so READY and FAILED happen without the status page open. | — |
| B-7 rate limits | Services see the real client address (`clientIp()`, X-Real-IP set by Kong from trusted proxies; a spoofed header is overwritten). Kong rate limits by IP. Patient OTP is capped per phone, per IP (`OTP_PER_IP_PER_10_MIN`) and per hospital (`OTP_PER_HOSPITAL_PER_HOUR`, 500). | Captcha on signup and OTP |
| H-5 document purge | Documents removed more than `DOCUMENT_PURGE_DAYS` (30) ago are deleted for good (object and row), hourly. | — |
| H-7 override end dates | Module and feature overrides take an optional end date (`until`, console form); the billing tick removes them when it passes. | Approvals for overrides and coupons |
| H-3 tracing | OpenTelemetry, preloaded with `--import @mc/nest-common/tracing` (dev, start, Docker, CI), off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set. HTTP (named by route template), fetch, pg and Redis spans; events carry `traceparent`, so a consumer's work joins the trace of the request that caused it. Query strings and Redis arguments are never exported (they can hold phone numbers). Verified with Jaeger: console request → event → notification consumer → entitlement call in one trace. | A collector and backend in the cluster; dashboards |
| H-6 Playwright in CI | The manual integration job builds and starts the zones and runs the Playwright suite after the API suites (traces uploaded on failure). | Its first run on GitHub (it is manual) |

Still open: support "act as" (Phase 31); captcha; approvals for overrides and coupons; the real-provider runs.

---

## 7. What works well (keep it)

- **Concurrency:**
  - single conditional UPDATEs plus the outbox;
  - idempotency keys on bookings, payments, lab orders and refunds;
  - race-safe tokens and slot holds (a 100-way booking race test);
  - advisory locks for capacity and limits.
- **Privacy:**
  - the tenant always comes from the host, and tokens are bound to the hospital;
  - 950-check tenancy leak test;
  - field-level encryption per hospital for notes and chats;
  - synchronous, fail-closed audit of record reads;
  - break-glass visible to the patient;
  - SMS without clinical detail; QR verification shows initials only.
- **Payments:** hold, expiry, late payment and auto-refund; refund policy; capped refunds.
- **Lab:**
  - result values stored together with their ranges, plus a history table;
  - amendments with versions and superseding;
  - home-visit state machine with a wrong-patient tube check and pay-before-collect.
- **SaaS:**
  - two-person plan approval with impact preview;
  - clean subscription state machine with a dev billing clock;
  - signup that creates nothing until the e-mail is confirmed;
  - read-only module rule in one place.
- **Search and AI:**
  - search with symptom synonyms and directory fallback;
  - assistant with emergency rules before the model, output policy, encrypted chats, a human handoff, and CI evals.
