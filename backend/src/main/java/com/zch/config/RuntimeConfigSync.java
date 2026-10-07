package com.zch.config;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.LongSupplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.DisposableBean;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.ApplicationListener;
import org.springframework.stereotype.Service;

/** Fixed delay after completion, one I/O in flight, no application-level retries inside a check. */
@Service
public class RuntimeConfigSync implements ApplicationListener<ApplicationReadyEvent>, DisposableBean {
    private static final Logger log = LoggerFactory.getLogger(RuntimeConfigSync.class);
    private final String instanceId;
    private final GatewayRuntimeProperties properties;
    private final RuntimeConfigSyncProperties config;
    private final RuntimeConfigSyncReader reader;
    private final ScheduledExecutorService executor;
    private final Clock clock;
    private final LongSupplier nanos;
    private ScheduledFuture<?> task;
    private boolean started, running, closed, checking;
    private long startedNanos, confirmedNanos, checksStarted, checksCompleted, failures, consecutiveFailures;
    private Instant lastCheckStartedAt, lastCheckCompletedAt, lastConfirmedAt, lastSuccessfulCheckAt;
    private RuntimeConfigSnapshot lastConfirmed;
    private String lastCheckOutcome = "none", reasonCode, reason;

    @Autowired
    public RuntimeConfigSync(GatewayRuntimeProperties properties, RuntimeConfigSyncProperties config,
                             RuntimeConfigSyncReader reader) {
        this(properties, config, reader, Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "runtime-config-sync");
            thread.setDaemon(true);
            return thread;
        }), Clock.systemUTC(), System::nanoTime);
    }

    RuntimeConfigSync(GatewayRuntimeProperties properties, RuntimeConfigSyncProperties config,
                      RuntimeConfigSyncReader reader, ScheduledExecutorService executor, Clock clock, LongSupplier nanos) {
        config.validate();
        this.instanceId = config.getInstanceId();
        this.properties = properties; this.config = config; this.reader = reader;
        this.executor = executor; this.clock = clock; this.nanos = nanos;
    }

    @Override public void onApplicationEvent(ApplicationReadyEvent event) { start(); }

    synchronized void start() {
        if (started || closed) return;
        started = true; startedNanos = nanos.getAsLong();
        if (!config.isEnabled()) return;
        running = true;
        task = executor.scheduleWithFixedDelay(this::checkOnce, 0, config.getIntervalMs(), TimeUnit.MILLISECONDS);
    }

    /** Package visibility is for controlled scheduling in tests, not a management trigger. */
    void checkOnce() {
        synchronized (this) {
            if (!running || checking) return;
            checking = true; checksStarted++; lastCheckStartedAt = clock.instant();
        }
        try {
            RuntimeConfigSnapshot confirmed = reader.read(Duration.ofMillis(config.getTimeoutMs()));
            synchronized (this) {
                if (!running) return; // A callback completing during shutdown must not publish.
                lastConfirmed = confirmed; lastConfirmedAt = clock.instant(); confirmedNanos = nanos.getAsLong();
                RuntimeConfigSnapshot before = properties.snapshot();
                RuntimeConfigSnapshot adopted;
                try { adopted = properties.adopt(confirmed); }
                catch (IllegalStateException error) {
                    String code = !before.epoch().equals(confirmed.epoch())
                            ? "CONFIG_SYNC_GENERATION_CHANGED" : "CONFIG_SYNC_VERSION_CONTENT_MISMATCH";
                    throw new ConfigProblem(503, code, "not-applicable", error.getMessage());
                }
                if (!adopted.equals(confirmed))
                    throw new ConfigProblem(503, "CONFIG_SYNC_OBSERVATION_BEHIND", "not-applicable",
                            "读取响应早于本地已采用版本；保留较新快照，等待下次检查");
                if (consecutiveFailures > 0)
                    log.info("Runtime config sync recovered: instance={}, version={}", instanceId, confirmed.version());
                if (!before.version().equals(adopted.version()))
                    log.info("Runtime config adopted by sync: instance={}, version={}", instanceId, adopted.version());
                checksCompleted++; lastCheckCompletedAt = clock.instant(); lastSuccessfulCheckAt = lastCheckCompletedAt;
                consecutiveFailures = 0; lastCheckOutcome = "ok"; reasonCode = null; reason = null;
            }
        } catch (Exception error) {
            synchronized (this) {
                if (!running) return;
                checksCompleted++; failures++; consecutiveFailures++;
                lastCheckCompletedAt = clock.instant(); lastCheckOutcome = "failed";
                String code = error instanceof ConfigProblem problem ? String.valueOf(problem.response().get("code"))
                        : "CONFIG_SYNC_READ_FAILED";
                if (!code.equals(reasonCode))
                    log.warn("Runtime config sync failed: instance={}, code={}; retaining local snapshot", instanceId, code);
                reasonCode = code;
                reason = error instanceof ConfigProblem ? error.getMessage()
                        : "后台 Redis 检查未获得有效响应；保留最后有效快照，下一周期重试";
            }
        } finally {
            synchronized (this) { checking = false; }
        }
    }

    /** No Redis access. Confirmation fields describe background reads only, never cluster-wide agreement. */
    public synchronized Map<String, Object> status() {
        var adoption = properties.adoption();
        boolean matches = lastConfirmed != null && lastConfirmed.equals(adoption.snapshot());
        Long ageMs = lastConfirmedAt == null ? null : elapsedMs(confirmedNanos);
        long uncheckedMs = started ? elapsedMs(startedNanos) : 0;
        boolean stale = lastConfirmedAt == null ? uncheckedMs > config.getStaleAfterMs() : ageMs > config.getStaleAfterMs();
        String state = closed ? "stopped" : !config.isEnabled() ? "disabled" : stale ? "stale"
                : checksCompleted == 0 ? "pending" : lastCheckOutcome.equals("failed") ? "failed" : !matches ? "pending" : "ok";
        String code = reasonCode, message = reason;
        if (stale && code == null) {
            code = "CONFIG_SYNC_CONFIRMATION_EXPIRED"; message = "最近一次存储确认已过期";
        } else if (lastCheckOutcome.equals("ok") && !matches) {
            code = "CONFIG_SYNC_LOCAL_CHANGED"; message = "本地版本已变化，等待后台检查确认";
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("source", "local"); body.put("confirmationScope", "background-read");
        body.put("instanceId", instanceId); body.put("status", state); body.put("running", running); body.put("checking", checking);
        body.put("reasonCode", code); body.put("reason", message); body.put("stale", stale);
        body.put("adoptedVersion", adoption.snapshot().version()); body.put("adopted", adoption.snapshot().response());
        body.put("lastAdoptedAt", timestamp(adoption.adoptedAt()));
        body.put("lastConfirmedVersion", lastConfirmed == null ? null : lastConfirmed.version());
        body.put("lastConfirmedAt", timestamp(lastConfirmedAt)); body.put("confirmationAgeMs", ageMs);
        body.put("matchesLastConfirmation", matches); body.put("lastCheckOutcome", lastCheckOutcome);
        body.put("lastCheckStartedAt", timestamp(lastCheckStartedAt)); body.put("lastCheckCompletedAt", timestamp(lastCheckCompletedAt));
        body.put("lastSuccessfulCheckAt", timestamp(lastSuccessfulCheckAt));
        body.put("checksStarted", checksStarted); body.put("checksCompleted", checksCompleted);
        body.put("failures", failures); body.put("consecutiveFailures", consecutiveFailures);
        body.put("intervalMs", config.getIntervalMs()); body.put("timeoutMs", config.getTimeoutMs());
        body.put("staleAfterMs", config.getStaleAfterMs());
        return body;
    }

    private long elapsedMs(long since) { return Math.max(0, TimeUnit.NANOSECONDS.toMillis(nanos.getAsLong() - since)); }
    private static String timestamp(Instant value) { return value == null ? null : value.toString(); }

    @Override
    public void destroy() {
        synchronized (this) {
            if (closed) return;
            closed = true; running = false;
            if (task != null) task.cancel(true);
        }
        executor.shutdownNow();
        reader.close();
        try {
            if (!executor.awaitTermination(2, TimeUnit.SECONDS)) log.warn("Runtime sync worker did not stop within shutdown budget");
        } catch (InterruptedException error) { Thread.currentThread().interrupt(); }
        log.info("Runtime config sync stopped: instance={}, checks={}", instanceId, checksCompleted);
    }
}
