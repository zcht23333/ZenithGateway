package com.zch.monitor;

import com.zch.config.GatewayRuntimeProperties;
import jakarta.annotation.PostConstruct;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedList;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.atomic.AtomicLong;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Sinks;

@Service
public class TrafficMetricsService {

    private final AuditEventPublisher auditEventPublisher;
    private final GatewayRuntimeProperties runtimeProperties;
    private final TreeMap<Long, SecondMetrics> perSecondMetrics = new TreeMap<>();
    private final LinkedList<TrafficMetricsSnapshot> snapshotHistory = new LinkedList<>();
    private static final int MAX_HISTORY_SIZE = 600;
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
                .map(ignore -> {
                    long tick = tickCounter.incrementAndGet();
                    int emitInterval = Math.max(1, runtimeProperties.getMonitor().getEmitIntervalSeconds());
                    if (tick % emitInterval != 0) {
                        return null;
                    }
                    return buildSnapshot();
                })
                .filter(snapshot -> snapshot != null)
                .cast(TrafficMetricsSnapshot.class)
                .subscribe(snapshot -> {
                    appendHistory(snapshot);
                    snapshotSink.emitNext(snapshot, Sinks.EmitFailureHandler.FAIL_FAST);
                });
    }

    public void accept(TrafficData trafficData) {
        long second = trafficData.getTimestamp() / 1000;
        synchronized (this) {
            SecondMetrics metrics = perSecondMetrics.computeIfAbsent(second, unused -> new SecondMetrics());
            metrics.totalCount++;
            metrics.latencySum += trafficData.getDurationMs();
            metrics.latencies.add(trafficData.getDurationMs());

            int status = trafficData.getStatusCode();
            if (status >= 200 && status < 300) {
                metrics.status2xx++;
            } else if (status >= 400 && status < 500) {
                metrics.status4xx++;
            } else if (status >= 500 && status < 600) {
                metrics.status5xx++;
            }
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
        synchronized (this) {
            if (snapshotHistory.isEmpty()) {
                return Collections.emptyList();
            }

            int fromIndex = Math.max(0, snapshotHistory.size() - safeSize);
            return new ArrayList<>(snapshotHistory.subList(fromIndex, snapshotHistory.size()));
        }
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

        synchronized (this) {
            pruneExpired(nowSecond - windowSeconds * 2L);

            for (Map.Entry<Long, SecondMetrics> entry : perSecondMetrics.tailMap(startSecond, true).entrySet()) {
                SecondMetrics metrics = entry.getValue();
                requestCount += metrics.totalCount;
                latencySum += metrics.latencySum;
                status2xx += metrics.status2xx;
                status4xx += metrics.status4xx;
                status5xx += metrics.status5xx;
                allLatencies.addAll(metrics.latencies);
            }
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
        Iterator<Long> iterator = perSecondMetrics.keySet().iterator();
        while (iterator.hasNext()) {
            long second = iterator.next();
            if (second < minSecond) {
                iterator.remove();
            } else {
                break;
            }
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
        synchronized (this) {
            snapshotHistory.add(snapshot);
            if (snapshotHistory.size() > MAX_HISTORY_SIZE) {
                snapshotHistory.removeFirst();
            }
        }
    }

    private static class SecondMetrics {
        private long totalCount;
        private long latencySum;
        private long status2xx;
        private long status4xx;
        private long status5xx;
        private final List<Long> latencies = new ArrayList<>();
    }
}

