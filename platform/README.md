# medicare-platform

Docs, local infrastructure and the `mc` CLI for MediCare. See the workspace [README](../README.md) for how to run everything.

- `docs/`: design (HLD, LLD, multi-tenancy, microservices, micro-frontends, plans, AI) and the implementation plan.
- `infra/`: docker-compose (Postgres, Redis, Redpanda, Keycloak, Kong, MinIO, Mailpit), Keycloak realm, generated Kong config.
- `scripts/mc.mjs`: zero-dependency CLI. `node scripts/mc.mjs` lists the commands.
- `tests/tenancy-leak.mjs`: discovers every route of every service and proves no hospital can read or change another's data.
- `tests/e2e/`: Playwright tests across zones; `tests/booking-race.mjs`, `tests/reminders.mjs`.
- `deploy/`: Helm charts, Argo CD, Terraform for GKE staging (see deploy/README.md).

Service and zone lists are never hard-coded here: they come from each backend service's `package.json` `"mc"` field and from `frontend/zones.json`.
