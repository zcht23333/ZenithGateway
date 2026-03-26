package com.zch.monitor;

import com.zch.config.GatewayRuntimeProperties;
import jakarta.annotation.PostConstruct;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentLinkedDeque;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ConcurrentSkipListMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.LongAdder;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Sinks;

@Service
public class TrafficMetricsService {

    private static final int MAX_HISTORY_SIZE = 600;
    private static final int MAX_P95_SAMPLES_PER_SECOND = 256;

    private final AuditEventPublisher auditEventPublisher;
    private final GatewayRuntimeProperties runtimeProperties;
    private final ConcurrentSkipListMap<Long, SecondMetrics> perSecondMetrics = new ConcurrentSkipListMap<>();
    private final ConcurrentLinkedDeque<TrafficMetricsSnapshot> snapshotHistory = new ConcurrentLinkedDeque<>();
    private final AtomicLong tickCounter = new AtomicLong(0);
    private final Sinks.Many<TrafficMetricsSnapshot> snapshotSink = Sinks.many().replay().latest();

    public TrafficMetricsService(AuditEventPublisher auditEventPublisher,
                                 GatewayRuntimeProperties runtimeProperties) {
        this.auditEventPublisher = auditEventPublisher;
        this.runtimeProperties = runtimeProperties;
    }

    @PostConstruct
    public void init() {
        auditEventPublisher.stream().subscribe(this::accept);

        Flux.interval(Duration.ZERO, Duration.ofSeconds(1))
                .filter(ignore -> {
                    long tick = tickCounter.incrementAndGet();
                    int emitInterval = Math.max(1, runtimeProperties.getMonitor().getEmitIntervalSeconds());
                    return tick % emitInterval == 0;
                })
                .map(ignore -> buildSnapshot())
                .subscribe(snapshot -> {
                    appendHistory(snapshot);
                    snapshotSink.emitNext(snapshot, Sinks.EmitFailureHandler.FAIL_FAST);
                });
    }

    public void accept(TrafficData trafficData) {
        long second = trafficData.getTimestamp() / 1000;
        SecondMetrics metrics = perSecondMetrics.computeIfAbsent(second, unused -> new SecondMetrics());
        metrics.totalCount.increment();
        metrics.latencySum.add(trafficData.getDurationMs());
        metrics.tryAddLatencySample(trafficData.getDurationMs());

        int status = trafficData.getStatusCode();
        if (status >= 200 && status < 300) {
            metrics.status2xx.increment();
        } else if (status >= 400 && status < 500) {
            metrics.status4xx.increment();
        } else if (status >= 500 && status < 600) {
            metrics.status5xx.increment();
        }
    }

    public Flux<TrafficMetricsSnapshot> stream() {
        return snapshotSink.asFlux();
    }

    public TrafficMetricsSnapshot latestSnapshot() {
        return buildSnapshot();
    }

    public List<TrafficMetricsSnapshot> recentSnapshots(int size) {
        int safeSize = Math.max(1, Math.min(size, MAX_HISTORY_SIZE));
        if (snapshotHistory.isEmpty()) {
            return Collections.emptyList();
        }

        List<TrafficMetricsSnapshot> all = new ArrayList<>(snapshotHistory);
        int fromIndex = Math.max(0, all.size() - safeSize);
        return all.subList(fromIndex, all.size());
    }

    private TrafficMetricsSnapshot buildSnapshot() {
        int windowSeconds = Math.max(1, runtimeProperties.getMonitor().getWindowSeconds());
        long nowSecond = Instant.now().getEpochSecond();
        long startSecond = nowSecond - windowSeconds + 1;

        List<Long> allLatencies = new ArrayList<>();
        long requestCount = 0;
        long latencySum = 0;
        long status2xx = 0;
        long status4xx = 0;
        long status5xx = 0;

        pruneExpired(nowSecond - windowSeconds * 2L);

        for (Map.Entry<Long, SecondMetrics> entry : perSecondMetrics.tailMap(startSecond, true).entrySet()) {
            SecondMetrics metrics = entry.getValue();
            requestCount += metrics.totalCount.sum();
            latencySum += metrics.latencySum.sum();
            status2xx += metrics.status2xx.sum();
            status4xx += metrics.status4xx.sum();
            status5xx += metrics.status5xx.sum();
            allLatencies.addAll(metrics.latencySamples());
        }

        TrafficMetricsSnapshot snapshot = new TrafficMetricsSnapshot();
        snapshot.setTimestamp(System.currentTimeMillis());
        snapshot.setWindowSeconds(windowSeconds);
        snapshot.setRequestCount(requestCount);
        snapshot.setQps(requestCount / (double) windowSeconds);
        snapshot.setAvgLatencyMs(requestCount == 0 ? 0 : latencySum / (double) requestCount);
        snapshot.setP95LatencyMs(calculateP95(allLatencies));
        snapshot.setStatus2xx(status2xx);
        snapshot.setStatus4xx(status4xx);
        snapshot.setStatus5xx(status5xx);
        return snapshot;
    }

    private void pruneExpired(long minSecond) {
        if (!perSecondMetrics.isEmpty()) {
            perSecondMetrics.headMap(minSecond, false).clear();
        }
    }

    private long calculateP95(List<Long> latencies) {
        if (latencies.isEmpty()) {
            return 0;
        }
        latencies.sort(Long::compareTo);
        int index = (int) Math.ceil(latencies.size() * 0.95) - 1;
        return latencies.get(Math.max(0, index));
    }

    private void appendHistory(TrafficMetricsSnapshot snapshot) {
        snapshotHistory.addLast(snapshot);
        while (snapshotHistory.size() > MAX_HISTORY_SIZE) {
            snapshotHistory.pollFirst();
        }
    }

    private static class SecondMetrics {
        private final LongAdder totalCount = new LongAdder();
        private final LongAdder latencySum = new LongAdder();
        private final LongAdder status2xx = new LongAdder();
        private final LongAdder status4xx = new LongAdder();
        private final LongAdder status5xx = new LongAdder();
        private final ConcurrentLinkedQueue<Long> latencySamples = new ConcurrentLinkedQueue<>();
        private final AtomicInteger sampleCount = new AtomicInteger(0);

        private void tryAddLatencySample(long latencyMs) {
            int current = sampleCount.getAndIncrement();
            if (current < MAX_P95_SAMPLES_PER_SECOND) {
                latencySamples.add(latencyMs);
            }
        }

        private List<Long> latencySamples() {
            return new ArrayList<>(latencySamples);
        }
    }
}

