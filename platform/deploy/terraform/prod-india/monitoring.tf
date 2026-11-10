# Checks from outside the cluster (Cloud Monitoring, several regions): they still alert when the cluster, its
# Prometheus or Alertmanager are down. The Prometheus SLO alerts (medicare-platform chart) cover everything inside.
resource "google_monitoring_notification_channel" "oncall" {
  display_name = "MediCare on-call"
  type         = "email"
  labels       = { email_address = var.oncall_email }
  depends_on   = [google_project_service.apis]
}

locals {
  uptime = {
    "marketing-site" = { host = var.domain, path = "/", content = "MediCare" }
    "status-api"     = { host = var.domain, path = "/api/tenant/v1/status", content = "\"components\"" }
    "sign-in"        = { host = var.domain, path = "/login", content = "Sign in" }
  }
}

resource "google_monitoring_uptime_check_config" "public" {
  for_each     = local.uptime
  display_name = "MediCare ${each.key}"
  timeout      = "10s"
  period       = "60s"
  http_check {
    path         = each.value.path
    port         = 443
    use_ssl      = true
    validate_ssl = true
  }
  monitored_resource {
    type   = "uptime_url"
    labels = { project_id = var.project_id, host = each.value.host }
  }
  content_matchers { content = each.value.content }
  selected_regions = ["ASIA_PACIFIC", "EUROPE", "USA_VIRGINIA"]
}

resource "google_monitoring_alert_policy" "uptime" {
  for_each     = local.uptime
  display_name = "MediCare ${each.key} unreachable"
  combiner     = "OR"
  conditions {
    display_name = "${each.key} failing from 2+ regions"
    condition_threshold {
      filter          = "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND resource.type=\"uptime_url\" AND metric.label.check_id=\"${google_monitoring_uptime_check_config.public[each.key].uptime_check_id}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 1
      duration        = "120s"
      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.host"]
      }
    }
  }
  notification_channels = [google_monitoring_notification_channel.oncall.id]
  documentation {
    content   = "Runbook: https://github.com/priyambansal13/hospital-CRM/blob/main/platform/docs/runbooks/service-down.md"
    mime_type = "text/markdown"
  }
}

resource "google_billing_budget" "monthly" {
  count           = var.billing_account == "" ? 0 : 1
  billing_account = var.billing_account
  display_name    = "MediCare ${var.env} monthly"
  budget_filter { projects = ["projects/${var.project_id}"] }
  amount {
    specified_amount {
      currency_code = "INR"
      units         = tostring(var.monthly_budget_inr)
    }
  }
  threshold_rules { threshold_percent = 0.5 }
  threshold_rules { threshold_percent = 0.9 }
  threshold_rules {
    threshold_percent = 1.0
    spend_basis       = "FORECASTED_SPEND"
  }
}
