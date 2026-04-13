# Health API

## GET /healthz

**Purpose:** Shallow liveness check suitable for Kubernetes liveness/readiness probes and load balancer health checks. Does not require authentication.

**Success**

- Status: `200 OK`
- Body (JSON):

```json
{ "status": "ok" }
```

**Failure** (critical dependency unavailable, e.g. database or cache ping failed)

- Status: `503 Service Unavailable`
- Body (JSON). The `reason` string is fixed and safe for operators; it does not include passwords, connection strings, or internal addresses:

```json
{ "status": "unavailable", "reason": "database connection failed" }
```

Other possible `reason` values include `cache unavailable` or the generic `dependency unavailable`.

**Authentication:** None. This route is registered outside the authenticated API group.

**Rate limiting:** The example router does not apply the sample rate-limit middleware to `/healthz`, so probes do not consume API quota.

**Logging:** Failed checks are logged at `WARN` with a structured error (not echoed in the JSON body). Successful checks log at `DEBUG` when enabled via `LOG_LEVEL=debug`. The router also emits a `healthz` access line at `DEBUG` (status and duration) so operators can tune verbosity without exposing secrets in HTTP responses.

**Latency:** Dependency pings use a short deadline (default 50ms per dependency) so the endpoint typically completes in under 100ms when dependencies are healthy or absent (demo server wires no DB/cache).
