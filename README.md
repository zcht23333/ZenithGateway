# ZenithGateway

A reactive API gateway with Redis rate limiting, bounded asynchronous audit persistence, dynamic routes, and a Vue dashboard.

Verified dependency baseline: Java 21, Spring Boot 4.1.1, Spring Cloud 2025.1.3 / Gateway 5.0.3, Node 24.21.0, and Redis 7.4.11. See the [upgrade and rollback report](docs/dependency-upgrade-execution.md) and [resolved dependency inventory](docs/dependency-upgrade-inventory.json).

## Project structure

```text
ZenithGateway/
|-- backend/       # Spring Boot / Maven gateway
|   |-- pom.xml
|   `-- src/
|-- frontend/      # Vue 3 / Vite dashboard
|   |-- package.json
|   `-- src/
|-- .mvn/wrapper/   # Pinned Maven distribution and checksum
|-- mvnw / mvnw.cmd # Maven Wrapper
|-- dev.ps1         # Windows development launcher
|-- observability/ # Prometheus, Grafana and fault demo
|-- verification/  # Containerized Linux build verification
|-- .node-version   # Verified Node LTS patch
|-- .gitignore
`-- README.md
```

On Linux/macOS, run `bash ./mvnw -f backend/pom.xml verify`; no global Maven installation is needed.
The Wrapper verifies the downloaded distribution against its committed SHA256. Configure private mirrors or credentials in your user Maven settings, not in the repository.

Open the repository root in IntelliJ IDEA and import `backend/pom.xml` as the Maven project.

## Included modules

- [filter/RateLimitFilter](backend/src/main/java/com/zch/filter/RateLimitFilter.java): per-IP token-bucket limiter (Redis Lua, atomic)
- [filter/AuditLogFilter](backend/src/main/java/com/zch/filter/AuditLogFilter.java): captures request timing/status and publishes asynchronously
- [monitor/AuditEventPublisher](backend/src/main/java/com/zch/monitor/AuditEventPublisher.java): bounded queue + background batched Redis list persistence
- [monitor/AuditQueryController](backend/src/main/java/com/zch/monitor/AuditQueryController.java): query recent audit events from Redis
- [monitor/TrafficMetricsService](backend/src/main/java/com/zch/monitor/TrafficMetricsService.java): rolling window aggregation (QPS/AVG/P95/status buckets)
- [monitor/SseController](backend/src/main/java/com/zch/monitor/SseController.java): SSE stream endpoint and latest metrics endpoint
- [monitor/DashboardController](backend/src/main/java/com/zch/monitor/DashboardController.java): chart-friendly snapshot/series API
- [config/RuntimeConfigController](backend/src/main/java/com/zch/config/RuntimeConfigController.java): runtime settings query/update API
- [config/RuntimeConfigSync](backend/src/main/java/com/zch/config/RuntimeConfigSync.java): bounded background configuration polling and local synchronization diagnostics
- [route/DynamicRouteService](backend/src/main/java/com/zch/route/DynamicRouteService.java): dynamic route registry persisted to Redis
- [route/DynamicRouteController](backend/src/main/java/com/zch/route/DynamicRouteController.java): route CRUD API (`/settings/routes`)
- [route/GatewayFallbackController](backend/src/main/java/com/zch/route/GatewayFallbackController.java): circuit breaker fallback JSON endpoint
- [config/GatewayRuntimeProperties](backend/src/main/java/com/zch/config/GatewayRuntimeProperties.java): runtime config for rate-limit/audit/monitor behavior

## Frontend app

[Product showcase and 80-second browser demo](docs/product-showcase.md) · [Final design, loading comparison and verification](docs/stage-c-final.md)

[Real HAProxy rolling replacement, failure evidence and reproduction](docs/backend-rolling-replacement.md) · [Recorded replacement](docs/backend-rolling-replacement-demo.webm)

- [frontend/src/views/Dashboard.vue](frontend/src/views/Dashboard.vue): real-time dashboard page
- [frontend/src/views/Settings.vue](frontend/src/views/Settings.vue): runtime config page
- [frontend/src/views/RouteDispatch.vue](frontend/src/views/RouteDispatch.vue): route dispatch canvas and searchable directory
- [frontend/src/stores/traffic.ts](frontend/src/stores/traffic.ts): SSE + REST data store (Pinia)
- [frontend/src/components/TrafficChart.vue](frontend/src/components/TrafficChart.vue): ECharts line chart
- [frontend/src/components/LogStream.vue](frontend/src/components/LogStream.vue): recent audit logs panel

## First-round hardening

Management authentication is required by default. Only the explicit `dev` profile permits an empty token. The dashboard accepts credentials at runtime; never build an admin token into Vite assets. See [setup and migration notes](docs/first-round.md) and [reproducible benchmarks](benchmarks/README.md).

## One-command development startup (Windows)

From the repository root, run:

```powershell
.\dev.ps1
```

The root launcher supports Windows PowerShell 5.1 and PowerShell 7. It checks JDK 21,
the included Maven Wrapper, Node.js 24 LTS and npm, builds the backend with tests skipped, and runs
`npm ci` when frontend dependencies are missing. It starts the backend with the
`dev` profile and the Vite dashboard, both bound to `127.0.0.1`. Open
[http://127.0.0.1:5173](http://127.0.0.1:5173) after the readiness message.

Redis is checked with PING (and AUTH when `REDIS_PASSWORD` is set). A reachable
instance is reused and left running on exit. If local Redis is unavailable, the
launcher uses Docker Desktop to start a workspace-specific Redis 7.4 container
with a pinned image digest, AOF and a named data volume. Containers started by the launcher are stopped
on exit; containers and data volumes are retained for the next run.
`REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` and `REDIS_DB` remain supported.
Automatic Docker startup is limited to local Redis without a configured password.

Keep the terminal open; press **Ctrl+C** for orderly shutdown and audit draining.
The launcher enables the local Actuator shutdown endpoint for this development
process only. An existing `ZENITH_ADMIN_TOKEN` is honored, including during
shutdown; enter it in the dashboard when configured.

Logs are written to `.dev/backend.log`, `.dev/backend.err.log`,
`.dev/frontend.log` and `.dev/frontend.err.log` (overwritten on the next start,
ignored by Git). If a service fails, the launcher reports the failure and cleans
up the other services it started.

Useful options:

```powershell
.\dev.ps1 -CheckOnly
.\dev.ps1 -SmokeTest
.\dev.ps1 -SkipBuild
.\dev.ps1 -InstallDependencies
.\dev.ps1 -UseExistingRedis
.\dev.ps1 -BackendPort 8081 -FrontendPort 5174 -RedisPort 6380
.\dev.ps1 -JavaHome 'C:\path\to\jdk-21'
```

`-CheckOnly` starts nothing. `-SmokeTest` starts the stack, checks backend health
through both direct and frontend-proxied URLs, then stops it. `-SkipBuild` requires
an existing backend JAR and does not compile source edits. After changing frontend
dependencies or the lockfile, use `-InstallDependencies` to rerun `npm ci`.
Custom frontend/backend ports automatically update the development proxy.

## Quick start

Requirements: JDK 21 (maintained patch), Node.js 24 LTS/npm, and Redis 7.4. Maven 3.9.16 is provided by the root Wrapper. Set `JAVA_HOME` to your JDK 21 installation.
Run all commands below from the `ZenithGateway` repository root; use separate terminals for the backend and frontend.

1. Start Redis on `127.0.0.1:6379` (or set `REDIS_HOST` / `REDIS_PORT`).
2. Run backend tests and package the application:

```powershell
.\mvnw.cmd -f backend/pom.xml clean verify
```

3. Start the app:

```powershell
$env:SPRING_PROFILES_ACTIVE = 'dev' # Local development only; see production setup above
.\mvnw.cmd -f backend/pom.xml spring-boot:run
```

4. Create a route (no hardcoded startup route):

Existing Redis Hash route data requires a coordinated, offline migration before starting this version. The route version is independent of runtime parameters. Read the [route publication, actual adoption and migration guide](docs/backend-route-publication.md). An existing snapshot/guard must not be deleted to bypass migration.

```powershell
$routeHeaders = @{ Authorization = "Bearer $env:ZENITH_ADMIN_TOKEN" }
$routeBase = Invoke-RestMethod "http://localhost:8080/settings/routes" -Headers $routeHeaders
$routeBase.snapshot # Review before submitting; do not refresh expectedVersion automatically on conflict.
$routeChange = @{
  expectedVersion = $routeBase.version
  route = @{ id = 'demo'; path = '/demo/**'; uri = 'https://httpbin.org';
    rewriteEnabled = $true; rewriteRegex = '/demo/(?<segment>.*)';
    rewriteReplacement = '/anything/${segment}'; circuitBreakerEnabled = $true }
}
Invoke-RestMethod "http://localhost:8080/settings/routes" -Method Post -Headers $routeHeaders -ContentType 'application/json' -Body ($routeChange | ConvertTo-Json -Depth 5)
```

5. Trigger traffic through gateway:

```powershell
curl "http://localhost:8080/demo/hello"
```

6. Query recent audit records:

```powershell
curl "http://localhost:8080/monitor/audit/recent?size=10"
```

7. Subscribe to real-time metrics via SSE:

```powershell
curl -N "http://localhost:8080/monitor/stream"
```

8. Query latest aggregated snapshot:

```powershell
curl "http://localhost:8080/monitor/metrics/latest"
```

9. Query dashboard series endpoint:

```powershell
curl "http://localhost:8080/dashboard/series?size=30"
```

10. Query/update versioned runtime settings (authenticated, Redis-confirmed):

```powershell
$headers = @{ Authorization = "Bearer $env:ZENITH_ADMIN_TOKEN" }
$current = Invoke-RestMethod "http://localhost:8080/settings/runtime" -Headers $headers
$current # Review the six values, version and this instance's adopted snapshot.
$next = @{
  expectedVersion = $current.version
  operationId = [guid]::NewGuid().ToString()
  rateLimitEnabled = $current.rateLimitEnabled
  replenishRate = 30
  burstCapacity = $current.burstCapacity
  requestedTokens = $current.requestedTokens
  monitorWindowSeconds = $current.monitorWindowSeconds
  emitIntervalSeconds = $current.emitIntervalSeconds
}
Invoke-RestMethod "http://localhost:8080/settings/runtime" -Method Put -Headers $headers -ContentType 'application/json' -Body ($next | ConvertTo-Json)
```

A missing version or operation ID returns **428**; a stale version returns **409** with the current stored snapshot. Keep the draft, compare changes and explicitly submit again after review. Do not automatically replace the version and retry the old form. The authenticated `/settings/runtime/adopted` endpoint reads local memory only; it does not confirm Redis. Read the [consistency, migration and rollback guide](docs/backend-config-consistency.md) before upgrading an existing instance.

Runtime configuration now follows shared Redis automatically: one background read per instance, with a 2-second delay after each check and a 1-second read budget. The authenticated `/settings/runtime/sync` endpoint only observes local synchronization state; it does not read Redis. A successful save confirms that commit, not adoption by every instance. See the [multi-instance sync design, actual convergence evidence and repeatable verification](docs/backend-config-sync.md).

11. Manage dynamic routes without restart:

```powershell
Invoke-RestMethod "http://localhost:8080/settings/routes" -Headers $routeHeaders
```

```powershell
$routeHeaders = @{ Authorization = "Bearer $env:ZENITH_ADMIN_TOKEN" }
$routeBase = Invoke-RestMethod "http://localhost:8080/settings/routes" -Headers $routeHeaders
$routeBase.snapshot # Review before submitting; do not refresh expectedVersion automatically on conflict.
$routeChange = @{
  expectedVersion = $routeBase.version
  route = @{ id = 'demo'; path = '/demo/**'; uri = 'https://httpbin.org';
    rewriteEnabled = $true; rewriteRegex = '/demo/(?<segment>.*)';
    rewriteReplacement = '/anything/${segment}'; circuitBreakerEnabled = $true }
}
Invoke-RestMethod "http://localhost:8080/settings/routes" -Method Post -Headers $routeHeaders -ContentType 'application/json' -Body ($routeChange | ConvertTo-Json -Depth 5)
```

```powershell
$routeBase = Invoke-RestMethod "http://localhost:8080/settings/routes" -Headers $routeHeaders
$routeBase.snapshot # Explicitly review deletion against this version.
Invoke-RestMethod "http://localhost:8080/settings/routes/demo" -Method Delete -Headers $routeHeaders -ContentType 'application/json' -Body (@{ expectedVersion = $routeBase.version } | ConvertTo-Json)
```

Route writes require `expectedVersion` (**428** if missing; **409** on conflict). GET returns a versioned envelope, not an array. `/settings/routes/adopted` and `/settings/routes/diagnostics` are authenticated, local-only observations. A commit confirms storage and reports this instance's adoption separately; other instances follow asynchronously. There are no route operation receipts or automatic retries: a lost response remains unknown, even if a subsequent GET returns equal values. See [validation evidence](docs/backend-route-publication-validation.json).

12. Start frontend dashboard:

```powershell
npm.cmd --prefix frontend ci
npm.cmd --prefix frontend run dev
```

## Frontend build

The build includes TypeScript checks and writes production assets to `frontend/dist`:

```powershell
npm.cmd --prefix frontend run build
```

Backend build output is written to `backend/target`.

## Notes

- CORS allows `http://localhost:5173` and `http://127.0.0.1:5173` for local dashboard development.
- Virtual threads are enabled via `spring.threads.virtual.enabled=true`.
- Circuit breaker fallback endpoint: `GET /fallback/default`.


## Audit and monitoring reliability

Monitoring and audit persistence now have independent switches. Audit records use bounded admission, background batches and Redis batch deduplication. The dashboard shows backlog, confirmed writes, dropped events and uncertain outcomes.

See [operation and configuration details](docs/audit-and-monitoring.md), [second-round design](docs/second-round.md), and [repeatable benchmarks](benchmarks/README.md).

## Readiness and operational visibility

Startup now waits for runtime configuration restoration before accepting traffic. Redis configuration failures abort startup; an absent key uses defaults. The root launcher checks `/actuator/health/readiness`. See the [implementation and validation report](docs/third-round.md) and [monitoring setup and fault demo](docs/observability.md) for a scoped Prometheus credential, a provisioned 17-panel Grafana dashboard, alerts and Linux verification.

The reproducible isolated performance/JFR workflow is described in [benchmarks](benchmarks/README.md).

Runtime submissions now require an `operationId` bound to the normalized request. Keep the same ID and body for a network retry; create a new ID after editing or reviewing a conflict. Query `/settings/runtime/operations/{operationId}` to confirm that operation, and `/settings/runtime/history?limit=20` for bounded history. A missing receipt means unknown. The 24-hour idempotency window and bounded history are described in the [operation protocol](docs/backend-config-operations.md). Current schema-3 storage also supports safe historical recovery; read the [rollback protocol, coordinated migration and isolated verification](docs/backend-config-rollback.md) before deployment.

Runtime rollback restores a successful historical commit's **complete post-commit snapshot as a new version**. The server verifies the source version and operation ID inside the same Lua decision as CAS and receipt publication. The settings page offers history, six-field comparison and explicit confirmation. See [safe runtime rollback](docs/backend-config-rollback.md); the prior developer instances have not been migrated automatically.

Ordinary HTTP proxies now have validated startup connect/header/read-idle/total deadlines, bounded connection pools, explicit 502/504/503 classification, and per-name local circuit breakers covering the complete response. Automatic proxy retry is disabled. See the [proxy resilience behavior, source audit and isolated fault verification](docs/backend-proxy-resilience.md); `/settings/proxy/diagnostics` observes authenticated local state. Existing development instances have not been upgraded.

Cold traffic admission and safe exit now have a [two-instance operating and validation guide](docs/backend-traffic-lifecycle.md). Readiness confirms restoration, not full-load capacity; authenticated local lifecycle diagnostics and an irreversible drain endpoint support bounded request/audit completion before process shutdown.
