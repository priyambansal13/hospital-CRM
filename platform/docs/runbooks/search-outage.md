# Search outage or slow search

**Alerts:**
- `MedicareSearchSlow` (page): more than 5% of doctor searches over 300 ms.
- `…Ticket`.
- Also seen as search-service 503 `SEARCH_UNAVAILABLE`.

## What still works (tested by `mc test chaos`)

- The patient site **falls back to the directory** (provider-service) when search doesn't answer within 1.5 s. Patients can still find doctors by name and specialty, but not by symptom synonyms.
- Booking is not affected.

## Do

1. **OpenSearch runs in the cluster** (medicare-platform chart, `opensearch.yaml`): check its pods, heap, disk, and `GET /_cluster/health` (red or yellow).
2. **Slow but up:** look at OpenSearch CPU and heap, and at query volume. The p95 target is 300 ms; idle it answers in about 15 ms locally.
3. **An index lost or corrupted:** indexes hold nothing that isn't elsewhere. Rebuild with `mc search reindex <slug>`, or `mc search reindex --all` (from provider and diagnostics).
4. **The service itself is down:** [a service is down](service-down.md).

## Confirm

- `GET /api/search/v1/public/search/doctors?q=chest+pain` answers 200 on a test hospital.
- `slo:mc_search_slow:ratio_rate5m` is under 0.05.
