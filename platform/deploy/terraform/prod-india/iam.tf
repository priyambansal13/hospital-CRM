# Workload Identity: each kind of workload gets its own Google service account with only what it needs.
resource "google_service_account" "workload" {
  account_id   = "medicare-workload"
  display_name = "MediCare ${var.env} services (secrets, data-key wrapping, documents)"
}

resource "google_project_iam_member" "secret_access" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.workload.email}"
}

resource "google_storage_bucket_iam_member" "workload_documents" {
  bucket = google_storage_bucket.documents.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.workload.email}"
}

resource "google_service_account_iam_member" "workload_wi" {
  for_each           = toset(["medicare-infra/external-secrets", "medicare-${var.env}/records-service", "medicare-${var.env}/medicare-workload"])
  service_account_id = google_service_account.workload.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[${each.key}]"
}

# Gemini on Vertex AI in Mumbai (docs/AI-AGENTS.md §10): only ai-assistant-service may call it
resource "google_service_account" "ai" {
  account_id   = "medicare-ai"
  display_name = "MediCare ${var.env} AI assistant (Vertex AI, ${var.region})"
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

# Operations jobs: backups, restore drills, the status page
resource "google_service_account" "ops" {
  account_id   = "medicare-ops"
  display_name = "MediCare ${var.env} operations jobs"
}

resource "google_storage_bucket_iam_member" "ops" {
  for_each = { backups = google_storage_bucket.backups.name, status = google_storage_bucket.status.name }
  bucket   = each.value
  role     = "roles/storage.objectAdmin"
  member   = "serviceAccount:${google_service_account.ops.email}"
}

resource "google_service_account_iam_member" "ops_wi" {
  service_account_id = google_service_account.ops.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[medicare-${var.env}/medicare-ops]"
}

# Kafka: the services connect with the workload account (SASL OAUTHBEARER through Workload Identity)
resource "google_project_iam_member" "kafka_client" {
  project = var.project_id
  role    = "roles/managedkafka.client"
  member  = "serviceAccount:${google_service_account.workload.email}"
}
