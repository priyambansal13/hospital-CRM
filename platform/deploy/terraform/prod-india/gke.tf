# GKE Autopilot, regional (control plane and nodes across three zones of Mumbai), private nodes
resource "google_container_cluster" "gke" {
  name                = local.name
  location            = var.region
  enable_autopilot    = true
  network             = google_compute_network.vpc.id
  subnetwork          = google_compute_subnetwork.gke.id
  deletion_protection = true
  ip_allocation_policy {
    cluster_secondary_range_name  = "pods"
    services_secondary_range_name = "services"
  }
  private_cluster_config {
    enable_private_nodes    = true
    enable_private_endpoint = false
    master_ipv4_cidr_block  = "172.16.0.0/28"
  }
  master_authorized_networks_config {
    dynamic "cidr_blocks" {
      for_each = var.master_authorized_networks
      content {
        display_name = cidr_blocks.key
        cidr_block   = cidr_blocks.value
      }
    }
  }
  release_channel { channel = "STABLE" }
  maintenance_policy {
    recurring_window {
      # Sunday 01:30–05:30 IST, the quietest hours for hospitals
      start_time = "2025-01-04T20:00:00Z"
      end_time   = "2025-01-05T00:00:00Z"
      recurrence = "FREQ=WEEKLY;BYDAY=SA"
    }
  }
  security_posture_config {
    mode               = "BASIC"
    vulnerability_mode = "VULNERABILITY_BASIC"
  }
  depends_on = [google_project_service.apis]
}
