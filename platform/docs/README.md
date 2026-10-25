# MediCare CRM: Hospital / Clinic CRM System Design

System design for a **multi-tenant SaaS** hospital CRM, sold to many hospitals and clinic chains, where:

- **Patients** search doctors by specialty, book appointments and lab tests, pay, and see their reports and full medical history.
- **Doctors** log in to manage availability, see their daily queue, write notes and prescriptions, order tests and review results.
- **Admins** manage branches, specialties, doctors, the test catalog, pricing, policies, roles, dashboards and audit logs.
- **AI agents** (Google Gemini) help patients book and understand reports, help doctors with summaries and notes, and help admins with analytics.
- **Features are configurable** by role and by subscription plan (hospital plans and patient memberships).

## Documents

| Doc | What's inside |
|---|---|
| [docs/IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md) | **Start here to build it:** 33 small phases (0–32) in 7 milestones, each a 1–2 week demoable slice with checklists and a shared definition of done; team and timeline estimate |
| [docs/ROLE-FLOWS-AND-GAPS.md](ROLE-FLOWS-AND-GAPS.md) | **Review of what is built (through Phase 22):** end-to-end flows for every role, the gaps found (production blockers, access control, clinical safety, dead ends) and a fix plan |
| [docs/HLD.md](HLD.md) | Actors, requirements, capacity estimate, service boundaries, key flows (booking + payment, consultation → lab → report, login), data stores, FHIR mapping, security/compliance, reliability, deployment, tech stack, roadmap, trade-offs |
| [docs/MULTI-TENANCY.md](MULTI-TENANCY.md) | SaaS for many hospitals: white-label product model, control plane vs regional cells, separate database per hospital (schema per service, routing, provisioning, migrations, moves), tenant context, patient identity across hospitals, onboarding saga, per-tenant config, SaaS billing vs patient payments to hospitals, security/ops/offboarding, compliance |
| [docs/MICROSERVICES.md](MICROSERVICES.md) | 17 services with owned data, APIs and events; sync vs async communication; sagas; cross-service data; multi-tenancy; repo layout; platform and ops |
| [docs/MICROFRONTENDS.md](MICROFRONTENDS.md) | Next.js Multi-Zones: shell, patient, doctor, lab, front-desk, admin, account, platform-console zones; shared packages; role/plan-driven navigation and UI gates |
| [docs/PRODUCT-MODULES-AND-PLANS.md](PRODUCT-MODULES-AND-PLANS.md) | Selling flexibly to any hospital type: 19 sellable modules with dependencies and manifests, editions (Clinic, Diagnostic Center, Hospital, Telehealth...), plan builder and versions, add-ons, pricing models and price books, custom contracts, hospital-level configuration (settings, custom fields, forms, workflow rules), module on/off lifecycle, data model, sales flows, console screens, testing |
| [docs/FEATURES-AND-PLANS.md](FEATURES-AND-PLANS.md) | Configurable roles and permissions, feature catalogue, hospital plans and patient memberships, how access is decided, data model, subscription lifecycle, usage metering, guards, admin screens |
| [docs/LLD.md](LLD.md) | Service code structure, ER diagram, PostgreSQL DDL, state machines, double-booking-safe booking code, cancel/reschedule/waitlist, REST API spec, authorisation, class diagram and patterns, events and outbox, reports, timeline, search, caching, notifications, audit, errors, testing |
| [docs/AI-AGENTS.md](AI-AGENTS.md) | Gemini-based agents: patient Care Concierge (chat, WhatsApp, voice), Doctor Copilot (summary, ambient scribe), Ops Agent, background agents; safety, tools, schema, orchestrator code, AI features per role/plan, evals, privacy, cost, rollout |

## Key design decisions at a glance

1. **Multi-tenant SaaS**: global control plane + regional cells; **every hospital has its own database** (one schema per service inside it; small hospitals share Postgres servers, Enterprise hospitals get dedicated servers); patient payments settle directly to each hospital.
2. **Microservices** that each own one schema in every hospital's database, Kafka events through an outbox, and sagas for booking and payment.
3. **Micro-frontends with Next.js Multi-Zones**: one independently deployed zone per portal, shared design system and auth packages.
4. **Modular product, packaging as data**: developers declare modules in manifests; the business builds editions, plans, prices and custom contracts in the console without deploys; hospitals configure settings, roles, custom fields and workflow rules within their plan; one entitlement service answers "can this user do this now?" for every service and zone.
5. **Pre-generated slot rows + conditional UPDATE + partial unique index** make double booking impossible; **hold-then-confirm** for online payment.
6. **Two-layer authorisation**: roles/permissions plus "treating relationship / consent / break-glass" for every patient record, with every read audited.
7. **Billing never blocks medical records**: a lapsed subscription limits new/premium actions only.
8. **Gemini agents use the CRM's APIs as tools** with the user's own permissions and plan; they draft and humans confirm; emergencies are caught by deterministic rules before the model. Real patient data goes through Vertex AI, not a free AI Studio key.
