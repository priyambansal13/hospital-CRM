# Handoff: where work stopped (2026-10-25)

## State
- Phases 0–22 are built (Phase 22: AI foundation and the knowledge-only concierge, `ai-assistant-service` on 4415).
- The flow review is in [ROLE-FLOWS-AND-GAPS.md](ROLE-FLOWS-AND-GAPS.md). Wave 1 (15 gaps) is fixed and verified; see §8 "Fix log".
- Last full run, all green:
  - backend typecheck/lint/unit;
  - frontend build;
  - 17 API suites, including `mc test gaps` and the tenancy leak test (970 checks, 0 leaks);
  - Playwright 54/54.
- Git: one repo for all three folders, pushed to https://github.com/priyambansal13/hospital-CRM (`main`, first commit `82217b9`).

## Resume here: wave 2 (not started; waiting for go-ahead)
Details are in ROLE-FLOWS-AND-GAPS.md §"Wave 2: access control and staff lifecycle".
1. Branch scoping (B-1)
2. Staff offboarding, resending an invite, resetting a password (B-2)
3. Split permissions, trim the default grants (B-4)
4. Audit of admin actions (B-8)
5. Nurse vitals
6. Critical-value escalation (C-2)
7. Desk alerts for chat requests

After wave 2:
- wave 3: desk/lab completeness, screens for APIs that have none yet;
- wave 4: production integrations;
- then Phase 23.

## Before working
- The dev stack is stopped. Start it from `platform/` with `node scripts/mc.mjs dev` (run it in the background), then `node scripts/mc.mjs seed demo` if needed.
- Do not stop the agentic-commerce or PayFlow Docker containers.
- Each folder's `.github/workflows` sits inside that folder, so GitHub doesn't run it. Moving them to the repo's top-level `.github/` with path filters is an open to-do.
- After each wave: update the fix log in ROLE-FLOWS-AND-GAPS.md, the Status section of IMPLEMENTATION-PLAN.md and the memory files. Report, and ask before starting the next wave.
