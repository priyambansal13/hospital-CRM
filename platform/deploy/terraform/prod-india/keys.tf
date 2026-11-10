# Cloud KMS (docs/MULTI-TENANCY.md §7): keys never leave KMS. data-key-wrapper wraps each hospital's data key
# (KEY_WRAPPER=gcp-kms, records-service, built and tested with a fake KMS); storage encrypts the buckets.
# backup-key-wrapper is for each hospital's backup key once the ops tooling can use KMS (open item, docs/OPERATIONS.md
# §8): until then backups wrap with the backup-master-key secret. Rotated every 90 days; old versions still decrypt, and
# `mc keys rewrap` moves wrapped keys to the new version.
resource "google_kms_key_ring" "medicare" {
  name       = local.name
  location   = var.region
  depends_on = [google_project_service.apis]
}

resource "google_kms_crypto_key" "keys" {
  for_each        = toset(["data-key-wrapper", "backup-key-wrapper", "storage"])
  name            = each.key
  key_ring        = google_kms_key_ring.medicare.id
  rotation_period = "7776000s"
  purpose         = "ENCRYPT_DECRYPT"
  lifecycle { prevent_destroy = true }
}

# the DR region needs its own key for the backups bucket kept there
resource "google_kms_key_ring" "dr" {
  name       = "${local.name}-dr"
  location   = var.dr_region
  depends_on = [google_project_service.apis]
}

resource "google_kms_crypto_key" "dr_storage" {
  name            = "storage"
  key_ring        = google_kms_key_ring.dr.id
  rotation_period = "7776000s"
  lifecycle { prevent_destroy = true }
}

data "google_storage_project_service_account" "gcs" {}

resource "google_kms_crypto_key_iam_member" "gcs" {
  for_each      = { main = google_kms_crypto_key.keys["storage"].id, dr = google_kms_crypto_key.dr_storage.id }
  crypto_key_id = each.value
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${data.google_storage_project_service_account.gcs.email_address}"
}

# records-service (and the services that read clinical fields through it) unwrap hospital data keys
resource "google_kms_crypto_key_iam_member" "workload_data_keys" {
  crypto_key_id = google_kms_crypto_key.keys["data-key-wrapper"].id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${google_service_account.workload.email}"
}

# only the operations jobs (backups, restore drills) will touch backup keys
resource "google_kms_crypto_key_iam_member" "ops_backup_keys" {
  crypto_key_id = google_kms_crypto_key.keys["backup-key-wrapper"].id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${google_service_account.ops.email}"
}
