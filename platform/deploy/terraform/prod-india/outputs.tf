output "cluster" { value = google_container_cluster.gke.name }
output "ingress_address" { value = google_compute_global_address.ingress.address }
output "edge_security_policy" {
  value       = google_compute_security_policy.edge.name
  description = "medicare-platform values: ingress.securityPolicy"
}
output "postgres_servers" {
  value       = { for k, v in google_sql_database_instance.pg : k => { private_ip = v.private_ip_address, connection = v.connection_name, kind = local.servers[k].kind } }
  description = "register each with `mc server add <id> --pooled --direct --peer [--kind DEDICATED]` (pg-1 registers itself)"
}
output "dr_replicas" { value = { for k, v in google_sql_database_instance.pg_dr : k => v.name } }
output "redis_host" { value = google_redis_instance.redis.host }
output "kafka_cluster" { value = google_managed_kafka_cluster.kafka.name }
output "image_registry" { value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}" }
output "kms_keys" {
  value       = { for k, v in google_kms_crypto_key.keys : k => v.id }
  description = "KEY_WRAPPER=gcp-kms with KMS_KEY_NAME = data-key-wrapper; backups use backup-key-wrapper"
}
output "buckets" {
  value = { documents = google_storage_bucket.documents.name, backups = google_storage_bucket.backups.name, status = google_storage_bucket.status.name }
}
output "service_accounts" {
  value = { workload = google_service_account.workload.email, ai = google_service_account.ai.email, ops = google_service_account.ops.email }
}
output "nat_addresses" {
  value       = google_compute_address.nat[*].address
  description = "fixed egress addresses to allow-list with Razorpay, MSG91 and Meta"
}
