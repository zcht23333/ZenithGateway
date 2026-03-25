package com.zch.monitor;

import com.zch.config.GatewayRuntimeProperties;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;

class TrafficMetricsServiceTest {

    @Test
    void shouldAggregateQpsLatencyAndStatus() {
        AuditEventPublisher publisher = Mockito.mock(AuditEventPublisher.class);
        GatewayRuntimeProperties properties = new GatewayRuntimeProperties();
        properties.getMonitor().setWindowSeconds(10);

        TrafficMetricsService service = new TrafficMetricsService(publisher, properties);

        long now = System.currentTimeMillis();

        service.accept(data(now - 1000, 25, 200));
        service.accept(data(now - 1000, 50, 200));
        service.accept(data(now - 500, 80, 429));
        service.accept(data(now, 120, 503));

        TrafficMetricsSnapshot snapshot = service.latestSnapshot();

        Assertions.assertEquals(4, snapshot.getRequestCount());
        Assertions.assertEquals(2, snapshot.getStatus2xx());
        Assertions.assertEquals(1, snapshot.getStatus4xx());
        Assertions.assertEquals(1, snapshot.getStatus5xx());
        Assertions.assertTrue(snapshot.getQps() > 0.0);
        Assertions.assertTrue(snapshot.getAvgLatencyMs() >= 25.0);
        Assertions.assertEquals(120, snapshot.getP95LatencyMs());
    }

    private TrafficData data(long ts, long durationMs, int status) {
        TrafficData trafficData = new TrafficData();
        trafficData.setTimestamp(ts);
        trafficData.setDurationMs(durationMs);
        trafficData.setStatusCode(status);
        trafficData.setPath("/proxy/test");
        trafficData.setMethod("GET");
        trafficData.setClientIp("127.0.0.1");
        return trafficData;
    }
}

