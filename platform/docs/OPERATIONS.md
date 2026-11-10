# MediCare operations

How MediCare is run in production: who is on call, what we promise, what alerts, how load and failures were tested, the status page, and the production setup in India. Built in Phase 30 part 2 (2026-11-10). The runbooks are in [runbooks/](runbooks/README.md).

---

## 1. On call

| | |
|---|---|
| Rota | One primary and one secondary, weekly, handing over on Monday at 10:00 IST. The secondary is paged if the primary doesn't acknowledge within 10 minutes. |
| **Page** (wake someone) | Patients or hospitals are affected now, or soon: error-budget fast burn, a service with no ready instance, Redis or the control database unreachable, the outbox backlog, notifications failing, two nights without a backup, a failed restore drill, uptime checks. |
| **Ticket** (working hours) | Slow burns, latency over 6 hours, dead-lettered events, late messages, restarts, a missed backup night, stale drills. |
| Response | A page: acknowledge within 10 minutes and post on the status page within 15 ([incident communication](runbooks/incident-communication.md)). A ticket: the next working day. |
| Where alerts go | Prometheus → Alertmanager (pager for `severity: page`, ticket queue for `ticket`). Uptime checks from Cloud Monitoring e-mail on-call directly, so they still arrive when the cluster is down. |
| After a page | A blameless review within 5 working days. |

## 2. Service-level objectives

Measured over 30 days from the services' own metrics (`mc_http_request_duration_seconds`). Targets come from docs/HLD.md §3.

| Objective | Target | Measured as | Error budget (30 days) |
|---|---|---|---|
| Availability, per service | 99.9% of requests not 5xx | `job:mc_request_errors:ratio_rate*` | 0.1%: about 43 minutes of full outage |
| Booking speed | 95% of `POST /v1/appointments` within 500 ms | `slo:mc_booking_slow:ratio_rate*` | 5% of bookings |
| Doctor search speed | 95% within 300 ms | `slo:mc_search_slow:ratio_rate*` | 5% of searches |
| Messages | sent within 15 minutes of being due | `mc_notification_delay_seconds` | — (alert) |
| Backups | every hospital backed up nightly, a sample restore-drilled weekly | `mc_backup_age_seconds`, `mc_backup_drill_ok` | — (alert) |
| Disaster recovery | RPO ≤ 5 min, RTO ≤ 1 h (HLD §9) | Delhi replicas' lag; a timed DR test | open: needs a real project |

Enterprise contracts promise 99.95% (PRODUCT-MODULES-AND-PLANS.md). For a dedicated-server hospital, measure it with `tenant` on its own dashboard.

## 3. Alerts

The rules are in `platform/deploy/helm/medicare-platform/files/prometheus-rules.yaml`: 11 recording rules and 20 alerts. Each alert carries a `runbook_url`. Rule unit tests are in `prometheus-rules.test.yaml`, and `mc k8s check` runs both through `promtool`. Burn-rate alerts use the multi-window method:
- page at **14.4×** budget over 1 h and 5 min (the budget gone in about 2 days);
- page at **6×** over 6 h and 30 min;
- ticket at **1×** over 3 days.

| Group | Alerts |
|---|---|
| Objectives | ErrorBudgetBurnFast / Slow / Ticket, BookingSlow (+Ticket), SearchSlow (+Ticket) |
| Services | ServiceNotReady, PodsRestarting, RedisUnreachable, ControlDatabaseUnreachable, OutboxBacklog, OutboxStuck, EventsDeadLettered |
| Messages | NotificationsFailing, NotificationsLate |
| Backups | BackupMissing, BackupMissingTwoNights, RestoreDrillFailed, RestoreDrillsStale |

**Metrics added for these** (2026-11-10):
- `mc_dependency_up{dependency}`, from every health check;
- a 300 ms bucket on the request histogram;
- `mc_notifications_total{channel,result}` and `mc_notification_delay_seconds{channel}` (notification-service);
- `mc_backup_age_seconds{tenant,server}`, `mc_backup_drill_ok{tenant}` and `mc_backup_drill_age_seconds{tenant}` (tenant-service, read from the backup catalogue at scrape time).

**Scraping:** each service gets a PodMonitor (medicare-service chart, `monitoring.enabled`) that labels its series `job=<service name>`. Before this, services were only annotated, which the Prometheus Operator ignores.

**Outside the cluster** (Terraform `monitoring.tf`): uptime checks from Asia, Europe and the US on the marketing site, the status API and sign-in, plus a monthly budget alert.

## 4. Load testing

`platform/load/`:
- `mc load prepare` builds the **loadtest** hospital: 40 doctors with a normal week of hours (Monday to Saturday, 09:00–13:00 and 17:00–20:30, 15-minute slots) and 200 patients signed in by OTP. Each patient comes from its own address, so the gateway's per-address limit applies per patient as it would in real life.
- `mc load run --profile local|rush` runs k6 (Docker `grafana/k6`).

The script follows a patient through the morning rush:
- **search** a symptom, specialty or name; four in ten then open a doctor's free times (14 days, as the patient app does);
- **book:** a signed-in patient loads a doctor's free times, books one (pay at the hospital) and cancels it, so times are never used up.

| Profile | Searches/s | Bookings/s | Duration | Where |
|---|---|---|---|---|
| `smoke` | 10 | 1 | 1 min | checks the script |
| `local` | 40 | 4 | 3 min after a 30 s ramp | a laptop |
| `rush` (the platform target, LLD §17) | 200 | 20 | 30 min after a 2 min ramp | staging: `mc load run --profile rush --base https://<gateway> --host loadtest.<domain>` |

Thresholds are the objectives:
- search p95 < 300 ms;
- booking p95 < 500 ms;
- free times p95 < 500 ms;
- under 1% failed;
- over 99% of checks passing.

A booking refused by a business rule (time just taken, one a day per doctor) counts as answered, not failed. The results go to `platform/load/results/` (not committed).

**Local results (2026-11-10)** are in §4.1. They are **not** a measure of production capacity: the laptop also runs every service, both Postgres servers, Kafka, OpenSearch, k6 itself, and two other projects' Docker stacks (load average 13–20 during runs). What the local runs are for: proving the test, and finding hot spots.

### 4.1 What the local runs found (2026-11-10)

| Run | Rate reached | Failed | search p50 / p95 | free times p50 / p95 | booking p50 / p95 | Thresholds |
|---|---|---|---|---|---|---|
| `smoke` (10 + 1 per s, 1 min) | 16 req/s, 74 bookings | 0% | 7 / 49 ms | 6 / 46 ms | 12 / 97 ms | **all pass** |
| `local` (40 + 4 per s, 3 min) | 35 req/s, 763 bookings (2/s) | 0.08% | 111 / 1,387 ms | 214 / 4,522 ms | 295 / 2,514 ms | latency fails, errors pass |

Machine load average 17–30 during these runs.

**Reading them:**
- At a light rate every objective holds with a wide margin. At 40 + 4 per second the median is still fine, but the 95th percentile is set by a laptop that runs everything at once.
- k6 ran out of virtual users for bookings (32), because slow free-times lists held them; so it reached 2 bookings a second, not 4.
- The 0.08% that failed were search answering 503 when OpenSearch (512 MB heap locally) took more than 3 s.
- **The capacity question is answered only by `rush` on staging.**

**Found and fixed while making the load test work:**
- **Removing a doctor's hours** failed with a 500 when any of those times had ever been booked (even a cancelled booking): the slot was deleted while an appointment still referred to it. Now such times are closed instead of deleted. There is a regression check in `mc test wave3`.
- **A new hospital's sign-in set-up** (iam-service) dead-lettered on a Keycloak 401 from a cached admin token. Now it retries with a new token.

**Worth knowing for staging:**
- The free-times list is about 84 KB for 14 days of a normal week (15-minute slots, two sessions, six days). It is the heaviest request a patient makes. If `rush` shows it on top, cache it per doctor for a few seconds, or page it by week.
- OpenSearch needs more than the local 512 MB heap: production values give it 2 GB.

## 5. Status page

- **Public:** `/status` on MediCare's site. It lists 10 components (hospital websites, sign-in, booking, records, lab, payments, messages, search, AI assistant, analytics and integrations). Each one's state comes from the services' readiness checks (every 30 s) and from open incidents. It also shows open incidents with their updates, and the past 14 days.
- **Console:** **Status page** (`/platform/status`). Support (`status:manage:tenant`) posts an incident or planned maintenance, its updates, and its resolution; the product team can read.
- **Hospitals' staff** see a banner on every staff page while an incident or maintenance is on (the next 24 hours, for planned maintenance).
- **A copy that doesn't depend on MediCare:** the `status-publish` CronJob (every minute, the ops image, `mc status publish`) writes `index.html` and `status.json` to a Cloud Storage bucket in Delhi, served at `status.<domain>`. If tenant-service can't be reached, the copy says "MediCare cannot be reached" instead of staying green.
- **Privacy:** the page never names a hospital or a patient (checked by `mc test status`).

## 6. Failure tests

`mc test chaos` stops one dependency at a time on the local stack, then starts it again. It only touches this project's own containers. Results, 2026-11-10:

| Taken away | What happens (all checks pass) |
|---|---|
| **Kafka** | Bookings still succeed (about 200 ms). Their events wait in the outbox, and the backlog is visible within about 15 s. When Kafka is back the outbox drains by itself and the patient's confirmation goes out. No restarts. |
| **Redis** | Reading keeps working: public lists, and a signed-in patient's appointments, even after the 30 s permissions cache expires. Every service stays **ready**. A booking is refused in about 0.1–1 s with 503 `DEPENDENCY_UNAVAILABLE` and `Retry-After`. When Redis is back, booking works again without restarts. |
| **The payment provider** | An online booking is refused with `PAYMENTS_UNAVAILABLE` and its slot is given back at once. Paying at the hospital still works. When the provider is back, online booking works. |
| **Search** | The API says `SEARCH_UNAVAILABLE`, and the patient site falls back to the directory. Search recovers by itself. |

**Fixed because of these tests:**
- **Redis:** a request waited up to 30 s for Redis (no command timeout).
  - Fix: `REDIS_COMMAND_TIMEOUT_MS`, default 1 s, plus a bounded reconnect.
- **Redis:** every service reported "not ready" when Redis was down, so Kubernetes would have taken **all** instances out of service and turned a partial outage into a full one.
  - Fix: readiness now depends only on the control database, and Redis shows as `degraded`.
- **Redis:** the request then answered an unexplained 500.
  - Fix: Redis errors are 503 `DEPENDENCY_UNAVAILABLE` with `Retry-After`.
- **Redis:** permissions failed with `ENTITLEMENTS_UNAVAILABLE` once the in-memory cache expired, because entitlement-service treated its Redis cache as required.
  - Fix: on a cache miss or error it works permissions out from the database.
- **Kafka:** the outbox backlog wasn't reported while sends failed (the metric was only set after a successful pass), and a send waited for librdkafka's 5-minute timeout while holding a transaction.
  - Fix: the backlog is counted every pass; sends give up after `KAFKA_SEND_TIMEOUT_MS` (15 s); one failed send per pass stops waiting on every other hospital.
- **Found while preparing the load test:** iam-service dead-lettered a new hospital's set-up when Keycloak rejected a cached admin token that hadn't expired yet.
  - Fix: on a 401 it gets a new token and retries once.
- **Found while testing the new alerts:** the notification dispatcher's retry SQL failed (`power(integer, text)`), which stopped all sending for a hospital after any failed send.
  - Fix: fixed in the previous release (2026-11-10).

## 7. Production setup in India

Terraform `platform/deploy/terraform/prod-india` (written and validated, **not applied**: there is no GCP project yet). Helm values are in `deploy/environments/production`, and the Argo CD apps are `applicationset-production.yaml` and `infrastructure-production.yaml`. `mc k8s check production` lints and renders all 26 apps, checks 184 resources against Kubernetes schemas, runs promtool on the alert rules, and runs `terraform fmt` and `validate` on both Terraform roots.

| Part | Production |
|---|---|
| Region | Mumbai `asia-south1`; disaster recovery in Delhi `asia-south2`. Patient data stays in India. |
| Kubernetes | GKE Autopilot, regional (three zones), private nodes, control plane limited to listed networks, STABLE channel, maintenance on Sundays 01:30–05:30 IST, security posture scanning, deletion protection |
| Postgres | `pg-1` (control plane and shared hospitals) plus shared servers and one dedicated server per Enterprise group, from variables. Each is Cloud SQL **regional HA** with point-in-time recovery for 7 days, 30 server backups kept in Delhi, TLS only, logical decoding (for moves), Query Insights, and a **read replica in Delhi**. |
| Redis | Memorystore STANDARD_HA (replica, automatic failover), TLS, 5 GB, `volatile-lru` |
| Kafka | Managed Service for Apache Kafka (3 vCPU and 12 GB to start), with services authenticating as the workload service account |
| Search | OpenSearch in the cluster (no managed GCP service). Indexes are rebuilt from the services, so nothing in them needs a backup. |
| Keys | Cloud KMS in Mumbai and Delhi, rotated every 90 days. Hospitals' data keys are wrapped by KMS (`KEY_WRAPPER=gcp-kms`, already supported), and buckets are CMEK-encrypted. |
| Storage | Documents (CMEK, versioned, 14-day soft delete). Backups in Delhi (CMEK, versioned, a **35-day retention lock** so a backup can't be deleted even by an admin, moved to Nearline at 7 days). The public status bucket. |
| AI | Gemini on **Vertex AI in `asia-south1`**: the `medicare-ai` service account, used only by ai-assistant-service. Confirm the models are offered in Mumbai before go-live. |
| Edge | One global address for the ingress, and Cloud Armor (OWASP rules, a per-address ceiling, adaptive DDoS protection). Cloud DNS records if the zone is hosted here; Cloud NAT with two fixed addresses for providers' allow-lists. |
| Secrets | Secret Manager, replicated to both regions: about 40 secrets, plus one admin password per database server |
| Cost | A monthly budget alert in INR (optional, with a billing account) |

**Disaster recovery:** the [regional disaster](runbooks/regional-disaster.md) runbook. The Delhi replicas give an RPO of seconds. The RTO depends on rebuilding the cluster in Delhi, which isn't pre-built, to save cost. It has not been timed: that needs a DR test in a real project.

## 8. Not done yet

- **Running it:** applying the Terraform, the CronJobs, a full DR test, and the `rush` load profile at 200 + 20 per second for 30 minutes all need the GCP project.
- **Backup keys in Cloud KMS:** the KMS key exists, but the ops tooling still wraps backup keys with the `backup-master-key` secret.
- **A one-command restore:** `mc backup restore` into production. Today the [restore runbook](runbooks/restore-a-hospital.md) uses `mc backup drill --keep` and a manual database swap.
- **Redis TLS:** production Redis has TLS (`SERVER_AUTHENTICATION`). The services' `REDIS_URL` must be `rediss://` with the instance's CA (secret `redis-ca`); untested.
- **Kafka authentication:** the services' Kafka client needs SASL OAUTHBEARER with Workload Identity for Managed Kafka; untested.
- **Dashboards:** a Grafana dashboard for the objectives (the recording rules are ready).
- **Paging integration:** PagerDuty or Opsgenie for Alertmanager.
- **On-call rota and escalation contacts:** need people.
