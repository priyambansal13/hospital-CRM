# Kafka outage (events not reaching Kafka)

**Alerts:**
- `MedicareOutboxBacklog` (page): more than 1,000 events waiting in a service's outbox.
- `MedicareOutboxStuck` (ticket): events waiting and nothing published for 15 minutes.

## What still works (tested by `mc test chaos`)

Everything a person does: bookings, records and payments are written to the service's own database together with their events (the outbox). Readiness doesn't depend on Kafka.

What is **late** until Kafka is back:
- confirmations, reminders and other messages;
- read models in other services (search, analytics, the doctor's queue in another service);
- workflow rules and webhooks.

Nothing is lost. When Kafka returns, every outbox drains by itself and consumers ignore duplicates (`processed_events`).

## Do

1. **Post on the status page:** component notifications, impact Minor: "Confirmations and reminders are delayed. Bookings and records work normally."
2. **Managed Kafka:** check the cluster's health in the console (brokers, under-replicated partitions, storage). The relay logs `relay tick failed` with the broker error, and a send gives up after `KAFKA_SEND_TIMEOUT_MS` (15 s) and is retried.
3. **Network or authentication:** the services connect through the Kafka subnet with the workload service account (`roles/managedkafka.client`). A Workload Identity or IAM change shows up as authentication errors in the relay logs.
4. **Disk full or partitions offline:** scale the cluster (`kafka_vcpus`, `kafka_memory_gb` in Terraform) and check topic retention.

## After

- `mc_outbox_pending` falls to 0 on every job within minutes.
- Look for events that failed while being handled, now that they arrive: [events dead-lettered](events-dead-lettered.md).
- Messages that were due during the outage go out late. Reminders that are now in the past are skipped by their own rules, not sent late.
