# Handoff: where work stopped (2026-10-30)

## State
- Phases 0–22 are built (Phase 22: AI foundation and the knowledge-only concierge, `ai-assistant-service` on 4415).
- The flow review is in [ROLE-FLOWS-AND-GAPS.md](ROLE-FLOWS-AND-GAPS.md). See §8 "Fix log" for details.
  - Wave 1 (15 gaps): fixed 2026-10-25.
  - Wave 2 (access control and staff lifecycle): fixed 2026-10-30.
- Tests:
  - `mc test gaps` covers wave 1.
  - `mc test wave2` covers wave 2 (45 checks).
  - The tenancy leak test has 1015 checks and found 0 leaks.
- Git: one repo for all three folders, at https://github.com/priyambansal13/hospital-CRM (`main`). Wave 2 is **not committed yet**.

## Resume here: wave 3 (not started; ask first)
§6 of ROLE-FLOWS-AND-GAPS.md lists wave 3, front-desk and lab completeness:
- E-1 to E-3: reschedule, future dates and receipts at the desk.
- D-3: staff booking of lab tests.
- Handing back cash refunds.
- D-12: undoing a no-show.
- D-10: home-visit dispatcher fixes.
- E-10: lab catalog editor.
- E-4 and E-5: branch edit with time zone, and the home windows editor.
- E-6 to E-8: patient screens for existing APIs.
- The missing notifications (4.G).

After wave 3:
- wave 4: production integrations;
- then Phase 23.

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
