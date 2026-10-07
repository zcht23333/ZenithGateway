package com.zch.monitor;

import com.zch.config.GatewayRuntimeProperties;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.ConcurrentLinkedDeque;
import java.util.concurrent.ConcurrentSkipListMap;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.LongAdder;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import reactor.core.Disposable;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Sinks;

@Service
public class TrafficMetricsService {
    private static final int MAX_HISTORY_SIZE = 600;
    private final GatewayRuntimeProperties properties;
    private final Clock clock;
    private final boolean enabled;
    private final Counter completed;
    private final ConcurrentSkipListMap<Long, SecondMetrics> seconds = new ConcurrentSkipListMap<>();
    private final ConcurrentLinkedDeque<TrafficMetricsSnapshot> history = new ConcurrentLinkedDeque<>();
    private final AtomicLong ticks = new AtomicLong();
    private final Sinks.Many<TrafficMetricsSnapshot> sink = Sinks.many().replay().latest();
    private Disposable timer;

    @Autowired
    public TrafficMetricsService(GatewayRuntimeProperties properties, MeterRegistry registry,
                                 @Value("${zenith.monitor.enabled:true}") boolean enabled) {
        this(properties, registry, enabled, Clock.systemUTC());
    }

    TrafficMetricsService(GatewayRuntimeProperties properties, MeterRegistry registry, boolean enabled, Clock clock) {
        this.properties = properties;
        this.clock = clock;
        this.enabled = enabled;
        this.completed = registry.counter("zenith.monitor.completed");
    }

    @PostConstruct
    public void init() {
        timer = Flux.interval(Duration.ZERO, Duration.ofSeconds(1))
                .filter(tick -> ticks.incrementAndGet() % Math.max(1, properties.getMonitor().emitIntervalSeconds()) == 0)
                .subscribe(tick -> {
                    TrafficMetricsSnapshot snapshot = latestSnapshot();
                    history.addLast(snapshot);
                    while (history.size() > MAX_HISTORY_SIZE) history.pollFirst();
                    sink.tryEmitNext(snapshot); // Only this timer publishes snapshots.
                });
    }

    @PreDestroy
    public void close() {
        if (timer != null) timer.dispose();
        sink.tryEmitComplete();
    }

    public void accept(TrafficData event) {
        if (!enabled) return;
        completed.increment();
        long second = event.getTimestamp() / 1000;
        long now = clock.instant().getEpochSecond();
        if (second < now - 120 || second > now) return;
        SecondMetrics metrics = seconds.computeIfAbsent(second, ignored -> new SecondMetrics());
        long duration = Math.max(0, event.getDurationMs());
        metrics.latency.record(duration);
        metrics.latencySum.add(duration);
        int code = event.getStatusCode() / 100;
        if (code >= 2 && code <= 5) metrics.status[code - 2].increment();
        if ("cancelled".equals(event.getOutcome())) metrics.cancelled.increment();
        if ("error".equals(event.getOutcome())) metrics.errors.increment();
        if (event.getStatusCode() == 0) metrics.unknown.increment();
    }

    public Flux<TrafficMetricsSnapshot> stream() { return sink.asFlux(); }

    public List<TrafficMetricsSnapshot> recentSnapshots(int size) {
        List<TrafficMetricsSnapshot> all = new ArrayList<>(history);
        return all.subList(Math.max(0, all.size() - Math.max(1, Math.min(size, MAX_HISTORY_SIZE))), all.size());
    }

    public TrafficMetricsSnapshot latestSnapshot() {
        int window = Math.max(1, Math.min(120, properties.getMonitor().windowSeconds()));
        long now = clock.instant().getEpochSecond();
        seconds.headMap(now - 120, false).clear();
        long[] counts = new long[LatencyHistogram.BOUNDS.length + 1];
        long[] statuses = new long[4];
        long latencySum = 0, cancelled = 0, errors = 0, unknown = 0;
        for (SecondMetrics second : seconds.subMap(now - window + 1, true, now, true).values()) {
            second.latency.addTo(counts);
            latencySum += second.latencySum.sum();
            for (int i = 0; i < 4; i++) statuses[i] += second.status[i].sum();
            cancelled += second.cancelled.sum();
            errors += second.errors.sum();
            unknown += second.unknown.sum();
        }
        long count = Arrays.stream(counts).sum();
        TrafficMetricsSnapshot snapshot = new TrafficMetricsSnapshot();
        snapshot.setTimestamp(clock.millis());
        snapshot.setWindowSeconds(window);
        snapshot.setRequestCount(count);
        snapshot.setQps(count / (double) window);
        snapshot.setAvgLatencyMs(count == 0 ? 0 : latencySum / (double) count);
        snapshot.setP95LatencyMs(LatencyHistogram.percentile95(counts));
        snapshot.setLatencyOverflow(counts[counts.length - 1]);
        snapshot.setStatus2xx(statuses[0]);
        snapshot.setStatus3xx(statuses[1]);
        snapshot.setStatus4xx(statuses[2]);
        snapshot.setStatus5xx(statuses[3]);
        snapshot.setCancelled(cancelled);
        snapshot.setErrors(errors);
        snapshot.setUnknownStatus(unknown);
        snapshot.setCompletedTotal((long) completed.count());
        snapshot.setEnabled(enabled);
        return snapshot;
    }

    private static final class SecondMetrics {
        final LatencyHistogram latency = new LatencyHistogram();
        final LongAdder latencySum = new LongAdder();
        final LongAdder[] status = {new LongAdder(), new LongAdder(), new LongAdder(), new LongAdder()};
        final LongAdder cancelled = new LongAdder(), errors = new LongAdder(), unknown = new LongAdder();
    }
}
