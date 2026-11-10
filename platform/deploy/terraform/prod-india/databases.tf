# Postgres servers (docs/MULTI-TENANCY.md §3): pg-1 holds the control plane (mc_control, Keycloak) and is also the
# first shared server; more shared servers and one per Enterprise group come from variables. The app creates
# medicare_template and one database per hospital on each (`mc server add`, `mc tenant create`).
# Every server: regional HA (standby in another zone, automatic failover), point-in-time recovery for 7 days, and
# a read replica in Delhi for a regional disaster (RPO: seconds of replication lag; target ≤ 5 min, HLD §9).
locals {
  servers = merge(
    { "pg-1" = { tier = var.control_db_tier, max_connections = 800, kind = "SHARED" } },
    { for k, v in var.shared_servers : k => merge(v, { kind = "SHARED" }) },
    { for k, v in var.dedicated_servers : k => merge(v, { kind = "DEDICATED" }) },
  )
}

resource "random_password" "pg_admin" {
  for_each = local.servers
  length   = 32
  special  = false
}

resource "google_sql_database_instance" "pg" {
  for_each            = local.servers
  name                = "${local.name}-${each.key}"
  database_version    = "POSTGRES_16"
  region              = var.region
  deletion_protection = true
  depends_on          = [google_service_networking_connection.private]
  settings {
    tier                        = each.value.tier
    edition                     = "ENTERPRISE"
    availability_type           = "REGIONAL"
    disk_type                   = "PD_SSD"
    disk_autoresize             = true
    deletion_protection_enabled = true
    user_labels                 = { app = "medicare", env = var.env, kind = lower(each.value.kind) }
    ip_configuration {
      ipv4_enabled    = false
      private_network = google_compute_network.vpc.id
      ssl_mode        = "ENCRYPTED_ONLY"
    }
    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      start_time                     = "20:30" # 02:00 IST, next to the per-hospital dumps
      transaction_log_retention_days = 7
      location                       = var.dr_region # server backups kept in Delhi
      backup_retention_settings { retained_backups = 30 }
    }
    maintenance_window {
      day          = 7  # Sunday
      hour         = 21 # 02:30 IST
      update_track = "stable"
    }
    database_flags {
      name  = "max_connections"
      value = tostring(each.value.max_connections)
    }
    # moving a hospital between servers uses logical replication (mc tenant move)
    database_flags {
      name  = "cloudsql.logical_decoding"
      value = "on"
    }
    database_flags {
      name  = "log_min_duration_statement"
      value = "1000"
    }
    insights_config {
      query_insights_enabled  = true
      record_application_tags = true
    }
  }
}

resource "google_sql_database_instance" "pg_dr" {
  for_each             = var.dr_replicas ? local.servers : {}
  name                 = "${local.name}-${each.key}-dr"
  database_version     = "POSTGRES_16"
  region               = var.dr_region
  master_instance_name = google_sql_database_instance.pg[each.key].name
  deletion_protection  = true
  replica_configuration { failover_target = false }
  settings {
    tier              = each.value.tier
    availability_type = "ZONAL"
    disk_type         = "PD_SSD"
    disk_autoresize   = true
    user_labels       = { app = "medicare", env = var.env, role = "dr-replica" }
    ip_configuration {
      ipv4_enabled    = false
      private_network = google_compute_network.vpc.id
      ssl_mode        = "ENCRYPTED_ONLY"
    }
  }
}

resource "google_sql_user" "admin" {
  for_each = local.servers
  name     = "postgres"
  instance = google_sql_database_instance.pg[each.key].name
  password = random_password.pg_admin[each.key].result
}

resource "google_sql_database" "keycloak" {
  name     = "keycloak"
  instance = google_sql_database_instance.pg["pg-1"].name
}

# ---------- Memorystore Redis: standard tier (replica in another zone, automatic failover), TLS ----------
resource "google_redis_instance" "redis" {
  name                    = "${local.name}-redis"
  region                  = var.region
  tier                    = "STANDARD_HA"
  replica_count           = 1
  read_replicas_mode      = "READ_REPLICAS_ENABLED"
  memory_size_gb          = var.redis_memory_gb
  redis_version           = "REDIS_7_2"
  authorized_network      = google_compute_network.vpc.id
  connect_mode            = "PRIVATE_SERVICE_ACCESS"
  auth_enabled            = true
  transit_encryption_mode = "SERVER_AUTHENTICATION" # REDIS_URL is rediss://, with the instance's CA
  redis_configs           = { "maxmemory-policy" = "volatile-lru" }
  maintenance_policy {
    weekly_maintenance_window {
      day = "SUNDAY"
      start_time {
        hours   = 21
        minutes = 0
      }
    }
  }
  depends_on = [google_service_networking_connection.private]
}

# ---------- Managed Service for Apache Kafka ----------
resource "google_managed_kafka_cluster" "kafka" {
  cluster_id = local.name
  location   = var.region
  capacity_config {
    vcpu_count   = var.kafka_vcpus
    memory_bytes = var.kafka_memory_gb * 1024 * 1024 * 1024
  }
  gcp_config {
    access_config {
      network_configs {
        subnet = google_compute_subnetwork.kafka.id
      }
    }
  }
  rebalance_config { mode = "AUTO_REBALANCE_ON_SCALE_UP" }
  labels     = { app = "medicare", env = var.env }
  depends_on = [google_project_service.apis]
}

# OpenSearch has no managed service on Google Cloud: it runs in the cluster (medicare-platform chart, opensearch.yaml,
# 3 nodes in production values). Its indexes are rebuilt from the services (`mc search reindex --all`), so it holds
# nothing that a backup must keep.
