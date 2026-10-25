output "cluster" { value = google_container_cluster.gke.name }
output "cloud_sql_private_ip" { value = google_sql_database_instance.pg.private_ip_address }
output "redis_host" { value = google_redis_instance.redis.host }
output "image_registry" { value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}" }
output "workload_service_account" { value = google_service_account.workload.email }
