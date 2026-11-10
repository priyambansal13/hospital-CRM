# A service is down

**Alerts and checks:**
- `MedicareServiceNotReady` (page): a deployment has no ready instance.
- `MedicarePodsRestarting` (ticket).
- A Cloud Monitoring uptime check: the marketing site, the status API or sign-in, failing from two or more regions.

## Do

1. **Which:** `kubectl -n medicare-production get pods`, then `kubectl describe pod` and `kubectl logs --previous` for the failing one.
2. **Readiness fails** (`/health/ready` 503): only the **control database** takes an instance out of service. Its check shows `controlDb: down`. Go to [a database server is down](database-server-down.md).
3. **Crash loop at start:**
   - a missing secret (External Secrets sync, Secret Manager);
   - a migration not yet run (the rollout's migration Job failed, see [failed migration ring](failed-migration-ring.md));
   - a bad image: roll back in Argo CD.
4. **Out of memory** (`OOMKilled`): raise `resources.limits.memory` for the service, then look for the leak in the memory graph.
5. **Uptime check fails but pods are fine:** the way in. Check:
   - the ingress and its ManagedCertificate;
   - Cloud Armor (a rule blocking real traffic shows as 403s in its logs);
   - DNS for the domain;
   - Kong (`medicare-platform` kong pods).
6. **Communicate:** post on the status page within 15 minutes.

## Confirm

- `kube_deployment_status_replicas_available` is above 0.
- The uptime checks pass.
- The error-budget alerts clear.
