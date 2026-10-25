# GKE staging (Terraform)

Creates the managed pieces for MediCare staging in `asia-south1`: VPC with private service access, GKE Autopilot,
Cloud SQL Postgres 16 (private IP, PITR), Memorystore Redis, Artifact Registry, Secret Manager secrets and a
Workload Identity service account. Everything inside the cluster is deployed by Argo CD (`../../argocd`).

```bash
terraform init && terraform apply -var project_id=<gcp-project>
# then: put secret values (gcloud secrets versions add medicare-staging-<key> ...), fill
# deploy/environments/staging/values.yaml from `terraform output`, push images, apply ../../argocd/*.yaml
```

Not applied yet: needs a GCP project and credentials.
