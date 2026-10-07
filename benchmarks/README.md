# Gateway reliability and performance benchmarks

Requirements: JDK 21, Node.js 24, Docker Compose. Set JAVA_HOME to JDK 21 and run from the repository root. The generator, JVM, upstream and Docker Redis share the host; these are development measurements, not a production capacity estimate.

## Reproduce

```powershell
docker compose -f benchmarks/compose.yml up -d --wait
$env:ZENITH_TEST_REDIS_PORT = '16379'
.\mvnw.cmd -f backend/pom.xml verify
node benchmarks/run.mjs
docker compose -f benchmarks/compose.yml down
```

The dedicated Redis listens on 127.0.0.1:16379. Use this disposable instance only. Route, runtime and audit keys are unique to each scenario/repetition; the limiter's fixed per-IP key is still exercised. Compose down removes the temporary Redis data.

The runner owns its gateway JVM, HTTP upstream and fault proxy. Gateway defaults to port 18080; upstream/proxy use free ports. It generates an admin token in memory without logging or saving it. An occupied gateway port causes a startup failure.

## Scenario matrix

| Scenario | Limiter | Monitor | Audit | Injection |
| --- | --- | --- | --- | --- |
| forward-only | Off | Off | Off | None |
| rate-limit | On | Off | Off | None |
| rate-limit-monitor | On | On | Off | None |
| rate-limit-audit | On | On | On | None |
| audit-delay | On | On | On | Delay only audit connection replies by 50 ms |
| redis-delay | On | On | On | Delay all gateway Redis replies by 50 ms |
| audit-disconnect | On | On | On | Disconnect audit during 20–60% of measurement; queue capacity 256 |

Each sample uses a new JVM (-Xms256m -Xmx512m), 15 seconds of warmup, then 30 seconds of measurement. Default closed-loop concurrency is 16. Three repetitions are performed, reversing scenario order on the second repetition. Limiter rate/capacity are set to the supported maximum of 10,000, with one token per request. The limiter remains enabled in the corresponding scenarios. The upstream returns fixed JSON.

First-round forward-only/rate-limit disabled monitoring implicitly through audit.enabled. The new runner explicitly disables both for those two scenarios. Compare audit overhead against rate-limit-monitor, which retains accurate independent monitoring.

The proxy delays chunks independently without serial bandwidth throttling. Audit-only faults leave the limiter connection direct. Whole-Redis latency still affects rate limiting and its existing 500 ms timeout/fail-open behavior.

## Sustained fixed arrival

```powershell
$env:BENCH_SCENARIOS = 'rate-limit-audit'
$env:BENCH_ARRIVAL_RATE = '3000'
$env:BENCH_DURATION_SECONDS = '300'
$env:BENCH_REPETITIONS = '3'
node benchmarks/run.mjs
```

A fixed arrival run uses 256 connections by default. Issuing a request does not wait for previous responses. The scheduler catches up at most 10 ms of arrivals per tick; older missed slots are counted as schedulerMisses. If the in-flight cap is reached, slots are counted as capacityMisses instead of silently reducing offered load.

Check `offered = issued + schedulerMisses + capacityMisses` and actual achieved requests/sec. Timing on a shared Windows host is not hard real time; intended arrival rate is not proof that every slot was dispatched. latencyMs measures dispatch to completion; scheduledLatencyMs also includes scheduling delay for issued requests. Missed slots are reported separately, not given fabricated latency values.

For a ramp, repeat shorter fixed-arrival runs at increasing rates, e.g. 4000, 6000, 8000. Stop interpreting throughput as sustainable when generator misses, capacity misses, response failures, or sustained audit accumulation become material.

## Parameters

| Environment variable | Default |
| --- | --- |
| BENCH_DURATION_SECONDS | 30 |
| BENCH_WARMUP_SECONDS | 15 |
| BENCH_REPETITIONS | 3 |
| BENCH_ARRIVAL_RATE | 0 (closed loop) |
| BENCH_CONNECTIONS | 16 closed loop / 256 fixed arrival |
| BENCH_SCENARIOS | All seven, comma separated to select |
| BENCH_REDIS_PORT | 16379 |
| BENCH_GATEWAY_PORT | 18080 |
| BENCH_REDIS_DELAY_MS | 50 |
| BENCH_JAR | backend/target/zg-1.0.0.jar |

Clear previously set BENCH_* variables when changing modes, especially an explicit BENCH_CONNECTIONS.

## Reports and assertions

Results are written to ignored `benchmarks/results/<UTC timestamp>/summary.json`, with a log per JVM. Record:

- Throughput, HTTP statuses, transport errors, dispatch and scheduled P50/P95/P99/max latency.
- Sampled process CPU fraction of the host and sampled JVM heap peak (not allocation rate or retained heap).
- Queue peak, reserved bytes, oldest age and final drained audit status.
- received/persisted/dropped/uncertain/retry deltas after warmup and after measurement drain.
- Monitor cumulative completion delta, audit receipt delta and reconciliation gap.
- Redis EVAL/EVALSHA/LPUSH/LTRIM command deltas; INFO commandstats includes Lua-internal list commands.
- Retained event ID uniqueness, resource sampling failures and raw per-second resource samples.

Each sample records its missing configuration key before startup, the confirmed startup snapshot, and warmup HTTP counts. The runner rejects fixed arrival rates above 10,000 when any selected scenario enables the limiter. Any HTTP 429 during warmup or measurement makes the run fail; the warmup JSON or measurement summary is retained for diagnosis. Reduce connections or offered arrival rate if the configured limit is reached; do not raise parameters beyond supported bounds or disable the limiter in limiter comparisons. Failed samples must not be included in performance comparisons.

The runner waits for pending=0 before and after measurement, up to 30 seconds. It fails on a monitor/request mismatch, audit/request mismatch, nonzero reconciliation gap or duplicate retained IDs. HTTP failures and healthy-load drops/uncertain counts must also be checked in the report; intentional fault scenarios can legitimately show drops.

Redis retains only 5,000 recent records. Benchmark full-history accounting therefore relies on acknowledgements and event counters, not total list length. Integration tests use retention above their total event count to verify every ID and inject acknowledgement loss after actual Redis execution.

A forced JVM termination can lose queued events and counters. Windows process termination in this runner is not an assertion of graceful Spring shutdown; dedicated lifecycle checks cover shutdown separately. See [operational semantics](../docs/audit-and-monitoring.md).

The first-round report remains in `baseline-2026-09-23.json/md`. Second-round results must report complete confirmed audit throughput along with HTTP throughput, since the first-round implementation dropped events.

## Lifecycle probes

Run `node benchmarks/lifecycle.mjs` separately from performance measurements. It starts only its own localhost gateway (default port 18081), temporarily enables the authenticated shutdown actuator on that test process, and verifies that graceful shutdown drains delayed audit writes without duplicates. A second process is force-killed with a backlog to demonstrate the documented non-durable memory boundary. It never enables shutdown in the application defaults. Results and logs use a separate `lifecycle-*` directory.

## Aggregate explicit report files

Optional Python 3 helper (no extra packages):

```powershell
python benchmarks/summarize.py benchmarks/results/<matrix-run>/summary.json benchmarks/results/<sustained-run>/summary.json --output benchmarks/second-round-2026-09-23.json
```

Include only comparable measurements from the final implementation. The compact aggregate records every repetition, medians and min/max ranges; full per-second samples remain in the original local report. `lifecycle.mjs` additionally checks a real Redis commit followed by a withheld TCP reply, requiring a successful retry with no duplicate event IDs.

## Dependency upgrade validation

See the [2026-09-23 dependency upgrade report](dependency-upgrade-2026-09-23.md) for old/new measurements on the same maintained runtimes, interleaved follow-up runs, sustained load, and fault/lifecycle verification. Performance uncertainty and generator misses are retained explicitly.

## Isolated Linux comparison and JFR

`profile.mjs` compares a saved pre-change JAR with the current JAR using dedicated Redis, upstream, gateway and load-generator containers. It needs at least 12 logical CPUs allocated to Docker; fixed disjoint CPU sets and the same pinned JDK/heap/collector are used for every variant. The collector defaults to explicit G1; set `PROFILE_GC=Serial` to reproduce the initial constrained-container diagnostics. The runner verifies each JVM collector with `jcmd VM.flags`. CPU pinning inside Docker Desktop does not isolate physical cores or host frequency scaling.

Save the original JAR before editing/building; do not use the candidate itself as the baseline. Then build the candidate, initialize local credentials and run from the repository root:

```powershell
node observability/setup.mjs
$env:PROFILE_BASELINE = 'D:/path/to/baseline.jar'
node benchmarks/profile.mjs
```

Linux uses `PROFILE_BASELINE=/path/to/baseline.jar node benchmarks/profile.mjs`. Optional `PROFILE_CANDIDATE` and `PROFILE_OUTPUT` select the candidate JAR and result directory. `PROFILE_COMPARISON_ONLY=true` selects a four-run baseline/candidate/candidate/baseline comparison without custom-meter variants or JFR; use it to compare two historical upgrade artifacts. Default output is `.dev/third-round/profile`. Avoid builds, monitoring scrapes and other load tests during measurement.

Order: baseline, candidate, candidate with custom timers disabled, disabled, candidate, baseline. Each fresh JVM receives 45 seconds warmup and 60 seconds closed-loop measurement with 16 connections, full audit and rate limiting. `PROFILE_JFR_ONLY=true` selects only the recording run. The last, separate candidate run records JFR; exclude it from unprofiled performance comparisons. All measured runs require HTTP 200, zero transport errors, received=confirmed=requests, zero dropped/unknown records and an empty final queue. Redis is private, has no host port, and is removed with the test containers at completion.

The report includes JAR/JFR SHA256 hashes and environment details. Export and summarize the recording with the same JDK:

```sh
python benchmarks/analyze-jfr.py .dev/third-round/profile/zenith.jfr
```

Raw allocation weights and execution samples need interpretation; blocked/parked workers alone do not prove lock contention. Two repetitions per variant give a local regression check, not statistical proof of a throughput gain or a production capacity promise. The previous dependency-upgrade measurements remain historical and use a different environment.

The compact JSON export keeps only the top frame needed by `analyze-jfr.py`; the original `.jfr` retains full stacks for JDK Mission Control or a deeper export. The helper uses binary subprocess redirection so PowerShell encoding and pipeline overhead do not affect large exports. Set JAVA_HOME to the matching JDK.


## Cold-start regression after configuration changes

Build the current backend JAR, ensure the three pinned profile images are available locally, and allocate at least 12 logical CPUs to Docker for the existing CPU sets. Run from the repository root:

```powershell
node benchmarks/cold-start.mjs
```

This invokes the actual `run.mjs` with one `rate-limit-audit` repetition (default 16 connections, 15 s warmup / 30 s measurement), then the actual `profile.compose.yml` and `profile-load.mjs` (16 connections, 45 s warmup / 60 s measurement). Both use independent Redis data and verify a missing runtime key before the gateway starts, version 1 with rate/capacity 10,000, all HTTP 200, zero transport errors, and complete accounting. The negative control retains the original illegal 1,000,000 startup settings and must exit 1 without creating the key. An excessive fixed arrival setting must fail before launch.

A random Compose project, localhost ports and test credential are owned by this check; existing gateways, profile projects and credentials are not reused. Containers and the temporary secret are removed on completion. Logs and the report remain in `.dev/config-consistency-p2/cold-start-<id>/` (override with `BENCH_COLD_OUTPUT`). This is a cold-start and normal-load validity check, not a replacement for the multi-repetition performance comparison or fault matrix. See [the P2 follow-up](../docs/backend-config-consistency-p2.md) for measured evidence.
