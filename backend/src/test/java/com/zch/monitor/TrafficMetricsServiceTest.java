package com.zch.monitor;

import com.zch.config.GatewayRuntimeProperties;
import com.zch.config.MonitorConfig;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.stream.IntStream;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class TrafficMetricsServiceTest {
    private final GatewayRuntimeProperties properties = new GatewayRuntimeProperties();
    private final Clock clock = Clock.fixed(Instant.ofEpochSecond(1000), ZoneOffset.UTC);
    private final TrafficMetricsService service = new TrafficMetricsService(properties, new SimpleMeterRegistry(), true, clock);

    @Test void aggregatesAllRequestsWithoutAuditSubscription() {
        service.accept(data(999000, 25, 200));
        service.accept(data(999000, 50, 200));
        service.accept(data(999100, 15, 301));
        service.accept(data(999500, 80, 429));
        service.accept(data(1000000, 120, 503));
        var snapshot = service.latestSnapshot();
        assertEquals(5, snapshot.getRequestCount());
        assertEquals(5, snapshot.getCompletedTotal());
        assertEquals(2, snapshot.getStatus2xx());
        assertEquals(1, snapshot.getStatus3xx());
        assertEquals(1, snapshot.getStatus4xx());
        assertEquals(1, snapshot.getStatus5xx());
        assertEquals(0.5, snapshot.getQps());
        assertTrue(snapshot.getP95LatencyMs() >= 120 && snapshot.getP95LatencyMs() <= 126);
    }

    @Test void unequalSecondsAreWeightedByRequests() {
        for (int i = 0; i < 10000; i++) service.accept(data(999000, 10, 200));
        for (int i = 0; i < 100; i++) service.accept(data(1000000, 1000, 503));
        assertEquals(10, service.latestSnapshot().getP95LatencyMs());
    }

    @Test void concurrentHistogramHasNoMissingSamples() {
        IntStream.range(0, 100000).parallel().forEach(i -> service.accept(data(1000000, 30, 200)));
        var snapshot = service.latestSnapshot();
        assertEquals(100000, snapshot.getRequestCount());
        assertEquals(100000, snapshot.getStatus2xx());
        assertEquals(30, snapshot.getP95LatencyMs());
    }

    @Test void windowsExcludeOldAndFutureSamplesAndCanChange() {
        service.accept(data(990000, 10, 200));
        service.accept(data(991000, 10, 200));
        service.accept(data(1000000, 30, 200));
        service.accept(data(1001000, 50, 200));
        assertEquals(2, service.latestSnapshot().getRequestCount());
        properties.setMonitor(new MonitorConfig(1, 1));
        assertEquals(1, service.latestSnapshot().getRequestCount());
        properties.setMonitor(new MonitorConfig(120, 1));
        assertEquals(3, service.latestSnapshot().getRequestCount());
    }

    @Test void reportsCancellationUnknownStatusAndOverflowExplicitly() {
        var event = data(1000000, 60001, 0);
        event.setOutcome("cancelled");
        service.accept(event);
        var snapshot = service.latestSnapshot();
        assertEquals(-1, snapshot.getP95LatencyMs());
        assertEquals(1, snapshot.getLatencyOverflow());
        assertEquals(1, snapshot.getCancelled());
        assertEquals(1, snapshot.getUnknownStatus());
        assertEquals(0, snapshot.getStatus2xx());
    }

    @Test void everyHistogramBoundaryMeetsQuantizationLimit() {
        for (long duration = 0; duration <= 60000; duration++) {
            var histogram = new LatencyHistogram();
            histogram.record(duration);
            long[] counts = new long[LatencyHistogram.BOUNDS.length + 1];
            histogram.addTo(counts);
            long reported = LatencyHistogram.percentile95(counts);
            assertTrue(reported >= duration && reported - duration <= Math.max(1, duration * .05),
                    "duration=" + duration + ", reported=" + reported);
        }
    }

    @Test void disabledMonitorDoesNotCount() {
        var disabled = new TrafficMetricsService(properties, new SimpleMeterRegistry(), false, clock);
        disabled.accept(data(1000000, 10, 200));
        assertEquals(0, disabled.latestSnapshot().getCompletedTotal());
        assertFalse(disabled.latestSnapshot().getEnabled());
    }

    static TrafficData data(long timestamp, long latency, int status) {
        var data = new TrafficData();
        data.setTimestamp(timestamp);
        data.setDurationMs(latency);
        data.setStatusCode(status);
        data.setMethod("GET");
        data.setPath("/test");
        data.setClientIp("127.0.0.1");
        data.setOutcome("completed");
        return data;
    }
}
