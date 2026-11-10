# The way in: one global address for the GKE ingress (all hosts: the apex, *.domain for hospitals, verified custom
# domains), Cloud Armor in front of it, and DNS when the zone is hosted here.
resource "google_compute_global_address" "ingress" {
  name = "${local.name}-ingress"
}

# Attached through the ingress BackendConfig (medicare-platform values: ingress.securityPolicy)
resource "google_compute_security_policy" "edge" {
  name = "${local.name}-edge"
  type = "CLOUD_ARMOR"

  # OWASP rules (SQL injection, XSS, local file inclusion, remote code execution), sensitivity 1 to start
  dynamic "rule" {
    for_each = { 1000 = "sqli-v33-stable", 1001 = "xss-v33-stable", 1002 = "lfi-v33-stable", 1003 = "rce-v33-stable" }
    content {
      priority = rule.key
      action   = "deny(403)"
      match {
        expr { expression = "evaluatePreconfiguredWaf('${rule.value}', {'sensitivity': 1})" }
      }
      description = "OWASP ${rule.value}"
    }
  }

  # a flood from one address: the gateway's own per-address limit is the finer one (Kong, 1200/min)
  rule {
    priority = 2000
    action   = "throttle"
    match {
      versioned_expr = "SRC_IPS_V1"
      config { src_ip_ranges = ["*"] }
    }
    rate_limit_options {
      conform_action = "allow"
      exceed_action  = "deny(429)"
      enforce_on_key = "IP"
      rate_limit_threshold {
        count        = 3000
        interval_sec = 60
      }
    }
    description = "per-address ceiling"
  }

  rule {
    priority = 2147483647
    action   = "allow"
    match {
      versioned_expr = "SRC_IPS_V1"
      config { src_ip_ranges = ["*"] }
    }
    description = "default"
  }

  adaptive_protection_config {
    layer_7_ddos_defense_config { enable = true }
  }
}

resource "google_dns_record_set" "apex" {
  count        = var.dns_managed_zone == "" ? 0 : 1
  managed_zone = var.dns_managed_zone
  name         = "${var.domain}."
  type         = "A"
  ttl          = 300
  rrdatas      = [google_compute_global_address.ingress.address]
}

resource "google_dns_record_set" "hospitals" {
  count        = var.dns_managed_zone == "" ? 0 : 1
  managed_zone = var.dns_managed_zone
  name         = "*.${var.domain}."
  type         = "A"
  ttl          = 300
  rrdatas      = [google_compute_global_address.ingress.address]
}

# status.<domain> → the status bucket (a CNAME to Cloud Storage; HTTPS through a load balancer can come later)
resource "google_dns_record_set" "status" {
  count        = var.dns_managed_zone == "" ? 0 : 1
  managed_zone = var.dns_managed_zone
  name         = "status.${var.domain}."
  type         = "CNAME"
  ttl          = 300
  rrdatas      = ["c.storage.googleapis.com."]
}
