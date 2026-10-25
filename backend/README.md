# medicare-backend

NestJS microservices (Fastify) with a **separate database per hospital** and one schema per service inside it
(docs: `../platform/docs/MULTI-TENANCY.md`).

| Path | What |
|---|---|
| `services/tenant-service` | Tenant catalog + provisioning (control plane), branches, branding |
| `services/iam-service` | Keycloak organizations and staff, patient OTP login and patient tokens |
| `services/entitlement-service` | Module registry, roles and permissions, `/v1/me/capabilities` |
| `services/scheduling-service` | Weekly hours, leave, slots (rolling 60 days, branch time zones), booking, cancel/reschedule, waitlist |
| `services/notification-service` | SMS/email confirmations, reminders, cancellations, waitlist alerts; templates (en/hi), preferences, delivery log |
| `services/patient-service` | Patient records per hospital (self + family, MRN), access check for booking |
| `services/provider-service` | Specialties, doctors, per-branch fees, publish/unpublish, public directory search |
| `libs/tenancy` | Tenant context, per-tenant DB router (verifies `tenant_meta`), migrations, outbox |
| `libs/nest-common` | Bootstrap, auth guard (tenant from host + token check), RFC 7807 errors, idempotency, events, route registry |
| `libs/entitlements-sdk` | `@RequirePermission` / `@RequireModule` / `@RequireFeature` with cached capabilities |
| `libs/kafka`, `libs/contracts` | Kafka client wrapper; event and API contracts |
| `modules/*.module.yaml` | Module manifests: permissions, features, nav, default role grants (`pnpm check:manifests`) |

Conventions:
- Each service's `package.json` has an `"mc"` block (port, schema, control/tenant, topics). The platform CLI reads it.
- Migrations: `migrations/control/*.sql` (control-plane DB) and `migrations/tenant/*.sql` (every hospital DB); applied by `mc migrate`. Never edit an applied migration.
- Every route declares access: `@Public`, `@TenantPublic`, `@Internal`, or (default) authenticated; plus `@RequireModule`/`@RequirePermission`.
- New service: `pnpm gen service <name>`. Routes with path params need a fixture in `../platform/tests/tenancy-leak.mjs`.

Images: `docker build --build-arg SERVICE=<name>-service .` (one Dockerfile for all services). Migrations in a cluster: `node dist/migrate.js all`.
