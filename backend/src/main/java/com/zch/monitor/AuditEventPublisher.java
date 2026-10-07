package com.zch.monitor;

import tools.jackson.databind.json.JsonMapper;
import com.zch.config.GatewayRuntimeProperties;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.DistributionSummary;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.SmartLifecycle;
import org.springframework.stereotype.Component;

/** Non-waiting admission, one worker, and capacity held until each event reaches a terminal state. */
@Component
public class AuditEventPublisher implements SmartLifecycle {
    private static final Logger log = LoggerFactory.getLogger(AuditEventPublisher.class);
    private static final List<String> REASONS = List.of("queue_full", "byte_limit", "oversized", "serialization", "shutdown");
    private final Object lock = new Object();
    private final ArrayDeque<Entry> queue = new ArrayDeque<>();
    private final GatewayRuntimeProperties.Audit config;
    private final JsonMapper mapper;
    private final AuditBatchWriter writer;
    private final Counter receivedMeter, persistedMeter, uncertainMeter, retryMeter;
    private final Map<String, Counter> dropMeters = new LinkedHashMap<>();
    private final Map<String, Long> drops = new LinkedHashMap<>();
    private final DistributionSummary batchSizes;
    private final Timer batchDuration;
    private final String processId = UUID.randomUUID().toString();
    private final AtomicLong sequence = new AtomicLong();
    private long received, persisted, uncertain, reservedBytes, retries, lastSuccessNanos, lastWarningNanos;
    private int pending, lastBatchSize;
    private long lastBatchDurationMs;
    private Entry oldestInFlight;
    private volatile boolean running, accepting;
    private volatile long drainDeadline = Long.MAX_VALUE;
    private Thread worker;
    private final java.util.concurrent.CompletableFuture<Void> stopped = new java.util.concurrent.CompletableFuture<>();
    private boolean stopRequested;

    public AuditEventPublisher(AuditBatchWriter writer, JsonMapper mapper,
                               GatewayRuntimeProperties properties, MeterRegistry registry) {
        this.writer = writer;
        this.mapper = mapper;
        this.config = properties.getAudit();
        config.validate();
        receivedMeter = registry.counter("zenith.audit.received");
        persistedMeter = registry.counter("zenith.audit.persisted");
        uncertainMeter = registry.counter("zenith.audit.uncertain");
        retryMeter = registry.counter("zenith.audit.retry");
        for (String reason : REASONS) {
            drops.put(reason, 0L);
            dropMeters.put(reason, registry.counter("zenith.audit.dropped", "reason", reason));
        }
        batchSizes = registry.summary("zenith.audit.batch.size");
        batchDuration = registry.timer("zenith.audit.batch.duration");
        Gauge.builder("zenith.audit.enabled", config, c -> c.isEnabled() ? 1 : 0).register(registry);
        Gauge.builder("zenith.audit.capacity", config, c -> c.getBufferSize()).register(registry);
        Gauge.builder("zenith.audit.byte.capacity", config, c -> c.getBufferMaxBytes()).register(registry);
        Gauge.builder("zenith.audit.queue.depth", this, p -> p.status().queueDepth()).register(registry);
        Gauge.builder("zenith.audit.queue.bytes", this, p -> p.status().reservedBytes()).register(registry);
        Gauge.builder("zenith.audit.pending", this, p -> p.status().pending()).register(registry);
        Gauge.builder("zenith.audit.inflight", this, p -> p.status().inFlight()).register(registry);
        Gauge.builder("zenith.audit.oldest.age", this, p -> p.status().oldestAgeMs()).register(registry);
        Gauge.builder("zenith.audit.last.success.age", this,
                p -> p.status().lastSuccessAgeMs() == null ? -1 : p.status().lastSuccessAgeMs()).register(registry);
    }

    public void publish(TrafficData data) {
        if (!config.isEnabled()) return;
        AuditEvent event = AuditEvent.copyOf(data, processId + "-" + sequence.incrementAndGet());
        long bytes = event.reservedBytes();
        synchronized (lock) {
            received++;
            receivedMeter.increment();
            String reason = !accepting ? "shutdown" : bytes > config.getEventMaxBytes() ? "oversized"
                    : pending >= config.getBufferSize() ? "queue_full"
                    : bytes > config.getBufferMaxBytes() - reservedBytes ? "byte_limit" : null;
            if (reason != null) {
                drop(reason, 1);
                return;
            }
            pending++;
            reservedBytes += bytes;
            queue.addLast(new Entry(event, bytes, System.nanoTime()));
            if (queue.size() == 1 || queue.size() == config.getBatchSize()) lock.notifyAll();
        }
    }

    @Override
    public synchronized void start() {
        if (running || stopRequested || !config.isEnabled()) return;
        running = accepting = true;
        drainDeadline = Long.MAX_VALUE;
        worker = Thread.ofPlatform().daemon().name("zenith-audit-writer").start(this::consume);
    }

    private void consume() {
        List<Entry> batch = new ArrayList<>();
        boolean attempted = false;
        try {
            while (true) {
                synchronized (lock) {
                    while (queue.isEmpty() && accepting) lock.wait();
                    if (queue.isEmpty() || expired()) break;
                    long flushAt = queue.peekFirst().enqueuedNanos
                            + TimeUnit.MILLISECONDS.toNanos(config.getFlushIntervalMs());
                    long wait;
                    while (accepting && queue.size() < config.getBatchSize()
                            && (wait = Math.min(flushAt, drainDeadline) - System.nanoTime()) > 0) {
                        TimeUnit.NANOSECONDS.timedWait(lock, wait);
                    }
                    if (expired()) break;
                    long bytes = 0;
                    while (!queue.isEmpty() && batch.size() < config.getBatchSize()) {
                        Entry next = queue.peekFirst();
                        if (bytes + next.bytes > config.getBatchMaxBytes()) break;
                        batch.add(queue.removeFirst());
                        bytes += next.bytes;
                    }
                    oldestInFlight = batch.getFirst();
                }
                List<String> payloads = new ArrayList<>(batch.size());
                var iterator = batch.iterator();
                while (iterator.hasNext()) {
                    Entry entry = iterator.next();
                    try {
                        String json = mapper.writeValueAsString(entry.event);
                        if (json.getBytes(StandardCharsets.UTF_8).length > config.getEventMaxBytes()) {
                            settle(List.of(entry), "oversized");
                            iterator.remove();
                        } else payloads.add(json);
                    } catch (Exception serialization) {
                        settle(List.of(entry), "serialization");
                        iterator.remove();
                    }
                }
                if (!batch.isEmpty()) {
                    long start = System.nanoTime();
                    long until = start + TimeUnit.MILLISECONDS.toNanos(config.getRetryMaxElapsedMs());
                    String batchId = batch.getFirst().event.eventId();
                    boolean confirmed = false;
                    int attempt = 0;
                    while (!expired() && System.nanoTime() < until) {
                        long remaining = Math.min(until, drainDeadline) - System.nanoTime();
                        if (remaining <= 0) break;
                        if (attempt++ > 0) {
                            synchronized (lock) { retries++; retryMeter.increment(); }
                        }
                        try {
                            attempted = true;
                            writer.write(batchId, List.copyOf(payloads), Duration.ofNanos(Math.min(remaining,
                                    TimeUnit.MILLISECONDS.toNanos(config.getCommandTimeoutMs()))));
                            confirmed = true;
                            break;
                        } catch (Exception failure) {
                            synchronized (lock) {
                                warn(failure);
                                long wait = Math.min(TimeUnit.MILLISECONDS.toNanos(Math.min(500, 25L << Math.min(attempt, 4))),
                                        Math.min(until, drainDeadline) - System.nanoTime());
                                long resumeAt = System.nanoTime() + Math.max(0, wait);
                                while ((wait = Math.min(resumeAt, drainDeadline) - System.nanoTime()) > 0)
                                    TimeUnit.NANOSECONDS.timedWait(lock, wait);
                            }
                        }
                    }
                    synchronized (lock) {
                        lastBatchSize = batch.size();
                        lastBatchDurationMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);
                        batchSizes.record(lastBatchSize);
                        batchDuration.record(System.nanoTime() - start, TimeUnit.NANOSECONDS);
                    }
                    settle(batch, confirmed ? "persisted" : attempted ? "uncertain" : "shutdown");
                }
                batch.clear();
                attempted = false;
                synchronized (lock) { oldestInFlight = null; }
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        } catch (Throwable unexpected) {
            log.error("Audit worker stopped unexpectedly; remaining records will be accounted for", unexpected);
        } finally {
            synchronized (lock) {
                accepting = false;
                settle(batch, attempted ? "uncertain" : "shutdown");
                settle(new ArrayList<>(queue), "shutdown");
                queue.clear();
                oldestInFlight = null;
            }
            try { writer.close(); } catch (Exception failure) { log.warn("Audit connection close failed", failure); }
            running = false;
            log.info("Audit writer stopped: {}", status());
        }
    }

    private boolean expired() { return System.nanoTime() >= drainDeadline; }

    private void settle(List<Entry> entries, String outcome) {
        if (entries.isEmpty()) return;
        synchronized (lock) {
            int count = entries.size();
            if ("persisted".equals(outcome)) {
                persisted += count;
                persistedMeter.increment(count);
                lastSuccessNanos = System.nanoTime();
            } else if ("uncertain".equals(outcome)) {
                uncertain += count;
                uncertainMeter.increment(count);
            } else drop(outcome, count);
            pending -= count;
            for (Entry entry : entries) reservedBytes -= entry.bytes;
        }
    }

    private void drop(String reason, int count) {
        drops.compute(reason, (key, value) -> value + count);
        dropMeters.get(reason).increment(count);
        warn(null);
    }

    private void warn(Exception failure) {
        long now = System.nanoTime();
        if (now - lastWarningNanos < TimeUnit.SECONDS.toNanos(10)) return;
        lastWarningNanos = now;
        log.warn("Audit backlog: pending={}, dropped={}, uncertain={}, lastError={}", pending, drops, uncertain,
                failure == null ? "admission/serialization/shutdown" : failure.getClass().getSimpleName());
    }

    public AuditStatus status() {
        synchronized (lock) {
            Entry oldest = oldestInFlight == null ? queue.peekFirst() : oldestInFlight;
            long now = System.nanoTime();
            return new AuditStatus(config.isEnabled(), accepting, received, persisted,
                    drops.values().stream().mapToLong(Long::longValue).sum(), Map.copyOf(drops), uncertain,
                    queue.size(), pending - queue.size(), pending, reservedBytes,
                    oldest == null ? 0 : TimeUnit.NANOSECONDS.toMillis(now - oldest.enqueuedNanos),
                    retries, lastBatchSize, lastBatchDurationMs,
                    lastSuccessNanos == 0 ? null : TimeUnit.NANOSECONDS.toMillis(now - lastSuccessNanos),
                    config.getBufferSize(), config.getBufferMaxBytes());
        }
    }

    /** Includes a pre-existing command and bounded connection/client close, not just queue draining. */
    public long shutdownBudgetMs() { return config.getShutdownDrainTimeoutMs() + config.getCommandTimeoutMs() + 2500; }

    @Override
    public void stop(Runnable callback) {
        stopped.thenRun(callback);
        synchronized (lock) {
            if (stopRequested) return;
            stopRequested = true;
            accepting = false;
            drainDeadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(config.getShutdownDrainTimeoutMs());
            lock.notifyAll();
        }
        // Repeated HTTP drain and context shutdown share one deadline and one stop coordinator.
        Thread.ofVirtual().name("zenith-audit-stop").start(() -> {
            try {
                if (worker != null) {
                    worker.join(shutdownBudgetMs());
                    if (worker.isAlive()) {
                        worker.interrupt();
                        log.error("Audit writer exceeded stop budget; final outcome is incomplete: {}", status());
                    }
                }
            } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
            finally { stopped.complete(null); }
        });
    }

    @Override
    public void stop() {
        stop(() -> {});
        try { stopped.get(shutdownBudgetMs() + 100, TimeUnit.MILLISECONDS); }
        catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
        catch (Exception failure) { log.warn("Audit stop confirmation unavailable within budget", failure); }
    }
    @Override public boolean isRunning() { return running; }
    // The traffic coordinator drains this writer before Netty; phase 0 remains a fallback stop.
    @Override public int getPhase() { return 0; }
    private record Entry(AuditEvent event, long bytes, long enqueuedNanos) { }
}
