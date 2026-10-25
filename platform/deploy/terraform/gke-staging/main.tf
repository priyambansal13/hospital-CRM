# MediCare staging on GKE (docs/MICROSERVICES.md §8, docs/MULTI-TENANCY.md §2–3):
#   VPC + private services access, GKE Autopilot, Cloud SQL Postgres 16 (private IP; hospital DBs are created by the
#   app), Memorystore Redis, Artifact Registry, Secret Manager secrets (values set out of band), Workload Identity.
locals {
  name = "medicare-${var.env}"
  # one Secret Manager secret per key the medicare-platform chart's ExternalSecret expects
  secret_keys = [
    "internal-api-token", "redis-url", "session-secret", "mc-iam-client-secret", "smtp-user", "smtp-password",
    "pg-admin-password", "pgbouncer-userlist",
    "db-password-svc-tenant", "db-password-svc-iam", "db-password-svc-entitlement", "db-password-svc-provider",
    "db-password-svc-scheduling", "db-password-svc-patient", "db-password-svc-notification", "db-password-svc-billing", "db-password-svc-records", "db-password-svc-audit", "db-password-svc-diagnostics",
    # Razorpay (test keys for staging); the webhook secret is the one set on the Razorpay dashboard's webhook
    "razorpay-key-id", "razorpay-key-secret", "razorpay-webhook-secret",
    # wraps each hospital's clinical-data key (records-service); to be replaced by a Cloud KMS key
    "mc-master-key",
    # HMAC key pair for the documents bucket (GCS XML API, S3-compatible)
    "s3-access-key", "s3-secret-key",
  ]
}

resource "google_project_service" "apis" {
  for_each = toset(["container.googleapis.com", "sqladmin.googleapis.com", "redis.googleapis.com", "artifactregistry.googleapis.com",
  "secretmanager.googleapis.com", "servicenetworking.googleapis.com", "compute.googleapis.com", "aiplatform.googleapis.com"])
  service            = each.key
  disable_on_destroy = false
}

# ---------- network ----------
resource "google_compute_network" "vpc" {
  name                    = local.name
  auto_create_subnetworks = false
  depends_on              = [google_project_service.apis]
}

resource "google_compute_subnetwork" "gke" {
  name                     = "${local.name}-gke"
  network                  = google_compute_network.vpc.id
  region                   = var.region
  ip_cidr_range            = "10.10.0.0/20"
  private_ip_google_access = true
  secondary_ip_range {
    range_name    = "pods"
    ip_cidr_range = "10.20.0.0/14"
  }
  secondary_ip_range {
    range_name    = "services"
    ip_cidr_range = "10.30.0.0/20"
  }
}

resource "google_compute_global_address" "private_services" {
  name          = "${local.name}-private-services"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.vpc.id
}

resource "google_service_networking_connection" "private" {
  network                 = google_compute_network.vpc.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_services.name]
}

# ---------- GKE Autopilot ----------
resource "google_container_cluster" "gke" {
  name                = local.name
  location            = var.region
  enable_autopilot    = true
  network             = google_compute_network.vpc.id
  subnetwork          = google_compute_subnetwork.gke.id
  deletion_protection = false # staging only
  ip_allocation_policy {
    cluster_secondary_range_name  = "pods"
    services_secondary_range_name = "services"
  }
  private_cluster_config {
    enable_private_nodes    = true
    enable_private_endpoint = false
    master_ipv4_cidr_block  = "172.16.0.0/28"
  }
  release_channel { channel = "REGULAR" }
}

# ---------- Cloud SQL: one Postgres server; the app creates mc_control, medicare_template and one DB per hospital ----------
resource "random_password" "pg_admin" {
  length  = 32
  special = false
}

resource "google_sql_database_instance" "pg" {
  name                = "${local.name}-pg"
  database_version    = "POSTGRES_16"
  region              = var.region
  deletion_protection = false # staging only
  depends_on          = [google_service_networking_connection.private]
  settings {
    tier              = var.db_tier
    availability_type = "ZONAL" # production: REGIONAL (HA standby in another zone)
    disk_autoresize   = true
    ip_configuration {
      ipv4_enabled    = false
      private_network = google_compute_network.vpc.id
    }
    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      start_time                     = "20:30" # 02:00 IST
    }
    database_flags {
      name  = "max_connections"
      value = "400"
    }
    insights_config { query_insights_enabled = true }
  }
}

resource "google_sql_user" "admin" {
  name     = "postgres"
  instance = google_sql_database_instance.pg.name
  password = random_password.pg_admin.result
}

resource "google_sql_database" "keycloak" {
  name     = "keycloak"
  instance = google_sql_database_instance.pg.name
}

# ---------- Memorystore Redis ----------
resource "google_redis_instance" "redis" {
  name               = "${local.name}-redis"
  region             = var.region
  tier               = "BASIC" # production: STANDARD_HA
  memory_size_gb     = 1
  redis_version      = "REDIS_7_2"
  authorized_network = google_compute_network.vpc.id
  connect_mode       = "PRIVATE_SERVICE_ACCESS"
  auth_enabled       = true
  depends_on         = [google_service_networking_connection.private]
}

# ---------- images ----------
resource "google_artifact_registry_repository" "images" {
  location      = var.region
  repository_id = "medicare"
  format        = "DOCKER"
  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions { keep_count = 20 }
  }
}

# ---------- secrets (values are added out of band: `gcloud secrets versions add`) ----------
resource "google_secret_manager_secret" "app" {
  for_each  = toset(local.secret_keys)
  secret_id = "${local.name}-${each.key}"
  replication {
    user_managed {
      replicas { location = var.region }
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "pg_admin" {
  secret      = google_secret_manager_secret.app["pg-admin-password"].id
  secret_data = random_password.pg_admin.result
}

# ---------- Workload Identity: pods read secrets as this service account (External Secrets) ----------
resource "google_service_account" "workload" {
  account_id   = "medicare-workload"
  display_name = "MediCare ${var.env} workloads"
}

resource "google_project_iam_member" "secret_access" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.workload.email}"
}

resource "google_service_account_iam_member" "external_secrets_wi" {
  service_account_id = google_service_account.workload.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[medicare-infra/external-secrets]"
}

# ---------- Gemini on Vertex AI: only ai-assistant-service may call it (docs/AI-AGENTS.md §10) ----------
# Patient chat goes to Vertex AI in this project and region under the Cloud agreement, never to an AI Studio key.
resource "google_service_account" "ai" {
  account_id   = "medicare-ai"
  display_name = "MediCare ${var.env} AI assistant (Vertex AI)"
}

resource "google_project_iam_member" "ai_vertex" {
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.ai.email}"
}

resource "google_service_account_iam_member" "ai_wi" {
  service_account_id = google_service_account.ai.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[medicare-${var.env}/ai-assistant-service]"
}
