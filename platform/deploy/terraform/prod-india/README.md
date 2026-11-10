# MediCare production in India (Terraform)

Written and validated (`mc k8s check production`: `terraform fmt -check` and `terraform validate`), **not applied**: there is no production GCP project yet. What it builds, and why, is in [docs/OPERATIONS.md](../../../docs/OPERATIONS.md) §7.

| File | What |
|---|---|
| `network.tf` | APIs, VPC and subnets (GKE, Kafka), private service access, Cloud NAT with two fixed addresses |
| `gke.tf` | Regional GKE Autopilot, private nodes, authorized networks, Sunday maintenance window |
| `databases.tf` | Cloud SQL servers (`pg-1` plus `shared_servers` and `dedicated_servers`), regional HA, PITR, Delhi replicas; Memorystore HA; Managed Kafka |
| `keys.tf` | Cloud KMS key rings in Mumbai and Delhi: data-key wrapper, backup-key wrapper, storage keys |
| `storage.tf` | Documents (CMEK), backups in Delhi (CMEK, retention lock), the public status bucket, Artifact Registry |
| `secrets.tf` | Secret Manager secrets (values added out of band), server admin passwords |
| `iam.tf` | Workload Identity service accounts: workload, AI (Vertex), ops |
| `edge.tf` | Ingress address, Cloud Armor, DNS records |
| `monitoring.tf` | Uptime checks from three regions with an on-call e-mail channel, budget alert |

## First apply

1. Create the project and a versioned state bucket `<project>-tfstate`, then copy `terraform.tfvars.example` to `terraform.tfvars`.
2. Initialise and apply:
   ```
   terraform init -backend-config="bucket=<project>-tfstate"
   terraform plan -out plan
   terraform apply plan
   ```
3. Add the secret values (`gcloud secrets versions add medicare-production-<key> --data-file=-`), then fill `deploy/environments/production/values.yaml` from `terraform output`.
4. Install the infrastructure apps (`argocd/infrastructure-production.yaml`), then the services (`argocd/applicationset-production.yaml`).
5. Register the extra Postgres servers with `mc server add` (the `postgres_servers` output). `pg-1` registers itself.
6. Before patients' data arrives:
   - run a restore drill and the DR test ([regional disaster](../../../docs/runbooks/regional-disaster.md));
   - run `mc load run --profile rush` on staging;
   - confirm Vertex AI's models in `asia-south1`.
