variable "project_id" {
  type        = string
  description = "GCP project for MediCare staging"
}
variable "region" {
  type    = string
  default = "asia-south1" # Mumbai: Indian hospitals' data stays in India (docs/MULTI-TENANCY.md §11)
}
variable "env" {
  type    = string
  default = "staging"
}
variable "domain" {
  type    = string
  default = "staging.medicare.app"
}
variable "db_tier" {
  type    = string
  default = "db-custom-2-7680" # staging; production uses dedicated, larger instances (and dedicated ones per Enterprise tenant)
}
