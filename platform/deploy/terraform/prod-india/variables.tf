variable "project_id" {
  type        = string
  description = "GCP project for MediCare production (its own project: separate IAM, billing and audit logs)"
}
variable "region" {
  type        = string
  default     = "asia-south1" # Mumbai: patient data stays in India (docs/MULTI-TENANCY.md §11)
  description = "Primary region"
}
variable "dr_region" {
  type        = string
  default     = "asia-south2" # Delhi: disaster-recovery replicas and backups, still in India
  description = "Disaster-recovery region"
}
variable "env" {
  type    = string
  default = "production"
}
variable "domain" {
  type        = string
  description = "Public domain, e.g. medicare.app (hospitals get <slug>.<domain>; MediCare's site is the apex)"
}
variable "dns_managed_zone" {
  type        = string
  default     = ""
  description = "Cloud DNS zone name for the domain, if DNS is hosted here (empty: records are created elsewhere)"
}
variable "control_db_tier" {
  type    = string
  default = "db-custom-4-16384"
}
variable "shared_servers" {
  description = "Shared Postgres servers for small hospitals (~100–150 hospital databases each, docs/MULTI-TENANCY.md §3). Registered with `mc server add` under these ids."
  type        = map(object({ tier = string, max_connections = optional(number, 800) }))
  default     = { "pg-2" = { tier = "db-custom-8-32768" } }
}
variable "dedicated_servers" {
  description = "Dedicated servers, one per Enterprise group (registered with --kind DEDICATED)"
  type        = map(object({ tier = string, max_connections = optional(number, 400) }))
  default     = {}
}
variable "dr_replicas" {
  type        = bool
  default     = true
  description = "A cross-region read replica of every Postgres server in dr_region (RPO of seconds; promoted in a regional disaster, runbook database-server-down)"
}
variable "redis_memory_gb" {
  type    = number
  default = 5
}
variable "kafka_vcpus" {
  type    = number
  default = 3
}
variable "kafka_memory_gb" {
  type    = number
  default = 12
}
variable "master_authorized_networks" {
  description = "CIDRs allowed to reach the GKE control plane (office VPN, CI runners)"
  type        = map(string)
  default     = {}
}
variable "oncall_email" {
  type        = string
  description = "Where uptime alerts go (also wire PagerDuty/Opsgenie into Alertmanager for the Prometheus alerts)"
}
variable "billing_account" {
  type        = string
  default     = ""
  description = "Billing account id for a monthly budget alert (empty: no budget)"
}
variable "monthly_budget_inr" {
  type    = number
  default = 300000
}
