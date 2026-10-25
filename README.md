# MediCare: multi-tenant hospital CRM

Three repos side by side (same layout as agentic-commerce):

| Repo | What's in it |
|---|---|
| [`platform/`](platform/) | Design docs (`platform/docs`), local infrastructure, the `mc` CLI, cross-repo tests (tenancy leak test, Playwright) |
| [`backend/`](backend/) | NestJS microservices + shared libraries + module manifests |
| [`frontend/`](frontend/) | Next.js Multi-Zones micro-frontends + shared packages |

Start with [platform/docs/README.md](platform/docs/README.md) (design) and [platform/docs/IMPLEMENTATION-PLAN.md](platform/docs/IMPLEMENTATION-PLAN.md) (phases and status).

## Run it locally

Needs Node ≥ 22, pnpm 12, Docker (about 2.5 GB free memory for the stack).

```bash
./platform/setup.sh                              # secrets, infra, install, build, DB bootstrap, migrations, gateway
node platform/scripts/mc.mjs dev                 # all services (44xx) + zones (34xx) in watch mode
node platform/scripts/mc.mjs seed demo           # in another terminal: hospitals citycare + sunrise
```

Open http://citycare.localhost:3400 (Chrome/Firefox resolve `*.localhost`; Safari doesn't).

- **Staff:** `admin@citycare.test` with the `DEV_STAFF_PASSWORD` from `platform/.env`.
- **Patients:** any mobile number; the OTP "SMS" arrives in Mailpit at http://localhost:61825.

## Tests

```bash
(cd backend && pnpm lint && pnpm test && pnpm check:manifests)    # unit + boundaries + manifests
(cd backend && pnpm test:integration)                              # needs infra + demo hospitals
node platform/scripts/mc.mjs test tenancy                          # cross-hospital leak test, every route
node platform/scripts/mc.mjs test race                             # 100 concurrent bookings for one slot → exactly 1 wins
node platform/scripts/mc.mjs test reminders                        # reminders scheduled, sent when due, skipped if cancelled
node platform/scripts/mc.mjs k8s check staging                     # Helm lint + render + kubeconform (deploy/README.md)
(cd platform && pnpm test:e2e)                                     # browser tests (services + zones running)
```

## Local ports

| What | Port |
|---|---|
| Zones: shell / patient (`/care`) / doctor (`/doctor`) / admin | 3400 / 3401 / 3402 / 3405 |
| tenant / iam / entitlement / provider / scheduling / patient / notification services | 4401 … 4407 |
| Kong gateway / admin | 61000 / 61001 |
| Keycloak | 61180 |
| PgBouncer (services) / Postgres (direct) / Redis / Redpanda | 61643 / 61432 / 61379 / 61092 |
| Mailpit UI / MinIO console | 61825 / 61901 |
