# Runbooks

What to do when an alert fires, or when a planned operation is due. The alert rules (`platform/deploy/helm/medicare-platform/files/prometheus-rules.yaml`) link to these pages. Objectives, severities and the on-call rota are in [OPERATIONS.md](../OPERATIONS.md).

**Every incident starts the same way:**
1. Acknowledge the page.
2. Open the console's **Status page** (`/platform/status`).
3. Within 15 minutes, post what patients and hospitals will notice: see [incident communication](incident-communication.md).

## When an alert fires

| Alert | Runbook |
|---|---|
| `MedicareErrorBudgetBurnFast`, `…Slow`, `…Ticket`, `MedicareBookingSlow` | [High errors or latency](high-errors-or-latency.md) |
| `MedicareSearchSlow` | [Search outage](search-outage.md) |
| `MedicareServiceNotReady`, `MedicarePodsRestarting`, an uptime check | [A service is down](service-down.md) |
| `MedicareRedisUnreachable` | [Redis outage](redis-outage.md) |
| `MedicareControlDatabaseUnreachable` | [A database server is down](database-server-down.md) |
| `MedicareOutboxBacklog`, `MedicareOutboxStuck` | [Kafka outage](kafka-outage.md) |
| `MedicareEventsDeadLettered` | [Events dead-lettered](events-dead-lettered.md) |
| `MedicareNotificationsFailing`, `MedicareNotificationsLate` | [SMS or e-mail outage](sms-email-outage.md) |
| `MedicareBackupMissing…`, `MedicareRestoreDrill…` | [Backups](backups.md) |
| (no alert: support tickets) payments failing | [Payment provider outage](payments-outage.md) |
| (no alert: support tickets) assistant answers "talk to the desk" | [AI provider outage](ai-provider-outage.md) |
| (no alert: support tickets) nobody can sign in | [Sign-in outage](sign-in-outage.md) |

## Planned operations

- [Move a hospital to another database server](tenant-move.md)
- [Restore one hospital from a backup](restore-a-hospital.md)
- [A migration ring failed](failed-migration-ring.md)
- [Regional disaster: run from Delhi](regional-disaster.md)

## Ground rules

- **Never** put a hospital's or a patient's name in the status page, a ticket title, or a chat channel outside the incident room.
- **Never run** `mc tenant purge` during an incident. It destroys a deleted hospital's data, and it is not a fix for anything.
- Read before you change. Each runbook says how to confirm a fix worked.
- **Afterwards:** write a short blameless review for every page within 5 working days, covering what happened, what helped, and what to change. Put follow-up work in the backlog.
