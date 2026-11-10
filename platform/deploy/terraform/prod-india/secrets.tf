# Secret Manager (values added out of band: `gcloud secrets versions add`), read by External Secrets into the cluster.
# Production differs from staging: hospitals' data keys are wrapped by Cloud KMS (keys.tf), so there is no
# mc-master-key secret. Backups still wrap with backup-master-key until the ops tooling uses KMS (open item).
locals {
  secret_keys = [
    "internal-api-token", "redis-url", "redis-ca", "session-secret", "mc-iam-client-secret", "smtp-user", "smtp-password",
    "pgbouncer-userlist", "replication-password", "keycloak-db-password",
    "db-password-svc-tenant", "db-password-svc-iam", "db-password-svc-entitlement", "db-password-svc-provider", "db-password-svc-scheduling",
    "db-password-svc-patient", "db-password-svc-notification", "db-password-svc-billing", "db-password-svc-records", "db-password-svc-audit",
    "db-password-svc-diagnostics", "db-password-svc-search", "db-password-svc-assistant", "db-password-svc-subscription", "db-password-svc-integration",
    "db-password-svc-analytics",
    # payments (Razorpay live keys and Route), SMS (MSG91 with DLT ids), WhatsApp (Meta Cloud API)
    "razorpay-key-id", "razorpay-key-secret", "razorpay-webhook-secret", "msg91-auth-key", "whatsapp-token", "whatsapp-app-secret",
    # MediCare's own ads (docs/SEO-AND-ADS.md §3.5): server-side conversions only
    "meta-capi-token",
    "s3-access-key", "s3-secret-key",
    "backup-master-key",
  ]
}

resource "google_secret_manager_secret" "app" {
  for_each  = toset(local.secret_keys)
  secret_id = "${local.name}-${each.key}"
  replication {
    user_managed {
      replicas { location = var.region }
      replicas { location = var.dr_region }
    }
  }
  depends_on = [google_project_service.apis]
}

# each server's admin password (used by `mc server add` and the bootstrap job), created here
resource "google_secret_manager_secret" "pg_admin" {
  for_each  = local.servers
  secret_id = "${local.name}-pg-admin-password-${each.key}"
  replication {
    user_managed {
      replicas { location = var.region }
      replicas { location = var.dr_region }
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "pg_admin" {
  for_each    = local.servers
  secret      = google_secret_manager_secret.pg_admin[each.key].id
  secret_data = random_password.pg_admin[each.key].result
}
