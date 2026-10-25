# Deploying MediCare (staging on GKE)

| Path | What |
|---|---|
| `terraform/gke-staging/` | GCP: VPC, GKE Autopilot, Cloud SQL Postgres 16, Memorystore Redis, Artifact Registry, Secret Manager, Workload Identity |
| `helm/medicare-platform/` | Per environment: shared config, secrets (External Secrets ← Secret Manager), PgBouncer, Kong routes, ingress, DB bootstrap Job, demo seed Job, Keycloak realm |
| `helm/medicare-service/` | One backend service: Deployment, Service, HPA, PDB, migration Job (PreSync hook, `node dist/migrate.js all`) |
| `helm/medicare-zone/` | One micro-frontend zone (`zone-<name>:3000`) |
| `argocd/` | AppProject, infrastructure apps (External Secrets, cert-manager, Redpanda, Keycloak, Kong), ApplicationSet for MediCare |
| `environments/<env>/` | `values.yaml` (hand-written) + `generated.yaml` / `apps.json` (from `mc k8s render <env>`; never edit) |

## Order of a sync (Argo CD waves)

1. Infrastructure apps (waves −3…−1): External Secrets, cert-manager → Redpanda, Keycloak → Kong.
2. `medicare-platform` (wave 0): config, secrets, PgBouncer, Kong routes, ingress; **DB bootstrap Job** (roles with per-role `search_path`, `mc_control`, `medicare_template`, schemas in the template and every hospital DB).
3. `tenant-service` (wave 1): its migration Job, then the pods.
4. Other services (wave 2): each runs its migration Job (control → template → every hospital DB, versions reported to the catalog), then rolls out.
5. Zones (wave 3). With `seedDemo: true`, a post-sync Job creates the synthetic hospitals citycare and sunrise.

## First-time setup

```bash
cd deploy/terraform/gke-staging && terraform init && terraform apply -var project_id=<gcp-project>
# add secret values: gcloud secrets versions add medicare-staging-<key> --data-file=-   (keys: see main.tf locals.secret_keys)
# fill deploy/environments/staging/values.yaml from `terraform output`
# build + push images (CI does this on main): backend/Dockerfile (SERVICE=…), frontend/Dockerfile (ZONE=…)
kubectl apply -f deploy/argocd/project.yaml -f deploy/argocd/infrastructure-staging.yaml -f deploy/argocd/applicationset-staging.yaml
```

## Checks you can run without a cluster

```bash
node scripts/mc.mjs k8s check staging        # helm lint --strict, render all apps, kubeconform schemas
cd deploy/terraform/gke-staging && terraform init -backend=false && terraform validate
```

## Notes

- **PgBouncer** runs in transaction-pooling mode (same config as local dev). Service roles carry their `search_path`; migrations and the bootstrap Job connect to Cloud SQL directly because they need session-level locks.
- **Zone images:** the shell's rewrites are fixed at build time from `ZONE_URL_TEMPLATE` (default `http://zone-{name}:3000`), so one image works in every namespace.
- **Not yet deployed:** this needs a GCP project and credentials. Before the first real deploy, check the pinned third-party chart versions and decide where Keycloak's own database lives (`keycloak` DB on the same Cloud SQL instance is created by Terraform).
