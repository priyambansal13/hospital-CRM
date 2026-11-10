locals {
  name = "medicare-${var.env}"
}

# Patients' documents and report PDFs (records-service; one prefix per hospital): CMEK, versioned, never public
resource "google_storage_bucket" "documents" {
  name                        = "${var.project_id}-${local.name}-documents"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  versioning { enabled = true }
  encryption { default_kms_key_name = google_kms_crypto_key.keys["storage"].id }
  soft_delete_policy { retention_duration_seconds = 1209600 } # 14 days
  lifecycle_rule {
    condition {
      num_newer_versions = 3
      with_state         = "ARCHIVED"
    }
    action { type = "Delete" }
  }
  depends_on = [google_kms_crypto_key_iam_member.gcs]
}

# Per-hospital encrypted backups (Phase 30), kept in Delhi: away from the Mumbai servers they protect
resource "google_storage_bucket" "backups" {
  name                        = "${var.project_id}-${local.name}-backups"
  location                    = var.dr_region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  versioning { enabled = true }
  encryption { default_kms_key_name = google_kms_crypto_key.dr_storage.id }
  # a backup cannot be deleted or overwritten for 35 days, even by an administrator (ransomware, mistakes)
  retention_policy { retention_period = 3024000 }
  lifecycle_rule {
    condition { age = 7 }
    action {
      type          = "SetStorageClass"
      storage_class = "NEARLINE"
    }
  }
  lifecycle_rule {
    condition { age = 90 }
    action { type = "Delete" }
  }
  depends_on = [google_kms_crypto_key_iam_member.gcs]
}

# The public status page (docs/OPERATIONS.md §5): static files written every minute by the status-publish CronJob,
# served from Cloud Storage so it still answers when the cluster or the gateway is down
resource "google_storage_bucket" "status" {
  name                        = "${var.project_id}-${local.name}-status"
  location                    = var.dr_region
  uniform_bucket_level_access = true
  website {
    main_page_suffix = "index.html"
    not_found_page   = "index.html"
  }
  cors {
    origin          = ["https://${var.domain}"]
    method          = ["GET"]
    response_header = ["Content-Type"]
    max_age_seconds = 60
  }
}

resource "google_storage_bucket_iam_member" "status_public" {
  bucket = google_storage_bucket.status.name
  role   = "roles/storage.objectViewer"
  member = "allUsers"
}

resource "google_artifact_registry_repository" "images" {
  location      = var.region
  repository_id = "medicare"
  format        = "DOCKER"
  docker_config { immutable_tags = true } # a released tag always means the same image
  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions { keep_count = 50 }
  }
  depends_on = [google_project_service.apis]
}
