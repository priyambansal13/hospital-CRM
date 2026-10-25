terraform {
  required_version = ">= 1.6"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 6.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
  # backend "gcs" { bucket = "<project>-tfstate", prefix = "medicare/staging" }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
