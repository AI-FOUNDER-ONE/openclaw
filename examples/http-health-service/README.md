# HTTP health service (example)

Minimal Go example: `GET /healthz` for Kubernetes liveness/readiness probes and load balancer checks.

## Run

```bash
cd examples/http-health-service
go mod tidy
go run ./cmd/server
```

Environment:

- `PORT` — listen port (default `8080`).
- `LOG_LEVEL` — set to `debug` for request/health debug logs (default info).

## API

See [docs/api.md](docs/api.md).

## Test

```bash
go test ./...
```

## Probe

```bash
curl -v http://127.0.0.1:8080/healthz
```

Expect `HTTP/1.1 200` and `{"status":"ok"}` with `Content-Type: application/json`. Typical latency stays under 100ms when dependencies are local or skipped (demo uses no DB/cache). To simulate failure, run a build that passes a real `DBPinger`/`CachePinger` and stop that dependency, then expect `503` with `{"status":"unavailable","reason":"..."}` (safe fixed strings only).
