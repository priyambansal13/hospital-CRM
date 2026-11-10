resource "google_project_service" "apis" {
  for_each = toset([
    "container.googleapis.com", "sqladmin.googleapis.com", "redis.googleapis.com", "artifactregistry.googleapis.com", "secretmanager.googleapis.com",
    "servicenetworking.googleapis.com", "compute.googleapis.com", "aiplatform.googleapis.com", "cloudkms.googleapis.com", "managedkafka.googleapis.com",
    "monitoring.googleapis.com", "logging.googleapis.com", "dns.googleapis.com", "billingbudgets.googleapis.com",
  ])
  service            = each.key
  disable_on_destroy = false
}

resource "google_compute_network" "vpc" {
  name                    = local.name
  auto_create_subnetworks = false
  depends_on              = [google_project_service.apis]
}

resource "google_compute_subnetwork" "gke" {
  name                     = "${local.name}-gke"
  network                  = google_compute_network.vpc.id
  region                   = var.region
  ip_cidr_range            = "10.10.0.0/20"
  private_ip_google_access = true
  secondary_ip_range {
    range_name    = "pods"
    ip_cidr_range = "10.20.0.0/14"
  }
  secondary_ip_range {
    range_name    = "services"
    ip_cidr_range = "10.30.0.0/20"
  }
  log_config {
    aggregation_interval = "INTERVAL_5_MIN"
    flow_sampling        = 0.2
  }
}

# Kafka's network attachment lives in its own subnet
resource "google_compute_subnetwork" "kafka" {
  name                     = "${local.name}-kafka"
  network                  = google_compute_network.vpc.id
  region                   = var.region
  ip_cidr_range            = "10.11.0.0/24"
  private_ip_google_access = true
}

resource "google_compute_global_address" "private_services" {
  name          = "${local.name}-private-services"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.vpc.id
}

resource "google_service_networking_connection" "private" {
  network                 = google_compute_network.vpc.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_services.name]
}

# private nodes reach the internet (Razorpay, MSG91, Meta, SMTP) through Cloud NAT with fixed addresses, which
# providers can allow-list
resource "google_compute_router" "nat" {
  name    = "${local.name}-nat"
  network = google_compute_network.vpc.id
  region  = var.region
}

resource "google_compute_address" "nat" {
  count  = 2
  name   = "${local.name}-nat-${count.index}"
  region = var.region
}

resource "google_compute_router_nat" "nat" {
  name                               = "${local.name}-nat"
  router                             = google_compute_router.nat.name
  region                             = var.region
  nat_ip_allocate_option             = "MANUAL_ONLY"
  nat_ips                            = google_compute_address.nat[*].self_link
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"
  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}
