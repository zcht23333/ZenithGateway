# Zenith-Gateway P2

P2 includes a runnable backend (Gateway + Monitor + Runtime Settings API) and a Vue3 dashboard.

## Included modules

- `filter/RateLimitFilter`: per-IP fixed-window limiter based on Redis `INCR`
- `filter/AuditLogFilter`: captures request timing/status and publishes asynchronously
- `monitor/AuditEventPublisher`: in-memory sink + async Redis list persistence
- `monitor/AuditQueryController`: query recent audit events from Redis
- `monitor/TrafficMetricsService`: rolling window aggregation (QPS/AVG/P95/status buckets)
- `monitor/SseController`: SSE stream endpoint and latest metrics endpoint
- `monitor/DashboardController`: chart-friendly snapshot/series API
- `config/RuntimeConfigController`: runtime settings query/update API
- `route/GatewayRouteConfig`: sample route `/proxy/** -> https://httpbin.org/anything/**`
- `config/GatewayRuntimeProperties`: runtime config for rate-limit/audit/monitor behavior

## Frontend app

- `zenith-dashboard-web/src/views/Dashboard.vue`: real-time dashboard page
- `zenith-dashboard-web/src/views/Settings.vue`: runtime config page
- `zenith-dashboard-web/src/stores/traffic.ts`: SSE + REST data store (Pinia)
- `zenith-dashboard-web/src/components/TrafficChart.vue`: ECharts line chart
- `zenith-dashboard-web/src/components/LogStream.vue`: recent audit logs panel

## Quick start

1. Start Redis on `127.0.0.1:6379` (or set `REDIS_HOST` / `REDIS_PORT`).
2. Run tests:

```powershell
mvn -q test
```

3. Start the app:

```powershell
mvn spring-boot:run
```

4. Trigger traffic through gateway:

```powershell
curl "http://localhost:8080/proxy/hello"
```

5. Query recent audit records:

```powershell
curl "http://localhost:8080/monitor/audit/recent?size=10"
```

6. Subscribe to real-time metrics via SSE:

```powershell
curl -N "http://localhost:8080/monitor/stream"
```

7. Query latest aggregated snapshot:

```powershell
curl "http://localhost:8080/monitor/metrics/latest"
```

8. Query dashboard series endpoint:

```powershell
curl "http://localhost:8080/dashboard/series?size=30"
```

9. Query/update runtime settings:

```powershell
curl "http://localhost:8080/settings/runtime"
```

```powershell
curl -X PUT "http://localhost:8080/settings/runtime" -H "Content-Type: application/json" -d '{"rateLimitEnabled":true,"requestsPerWindow":30,"rateLimitWindowSeconds":1,"monitorWindowSeconds":10,"emitIntervalSeconds":1}'
```

10. Start frontend dashboard:

```powershell
Set-Location "D:\Java\zg\zenith-dashboard-web"
npm install
npm run dev
```

## Notes

- CORS allows `http://localhost:5173` for local dashboard development.
- Dynamic route hot-reload and circuit breaker remain as next milestones.

