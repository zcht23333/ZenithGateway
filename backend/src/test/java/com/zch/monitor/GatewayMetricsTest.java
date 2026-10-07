package com.zch.monitor;

import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import org.springframework.boot.availability.ApplicationAvailabilityBean;
import static org.junit.jupiter.api.Assertions.*;

class GatewayMetricsTest {
    @Test void arbitraryStatusesAndOutcomesCannotCreateUnboundedLabels() {
        var registry = new SimpleMeterRegistry();
        var metrics = new GatewayMetrics(registry, true, new ApplicationAvailabilityBean());
        int initial = registry.getMeters().size();
        for (int i = 0; i < 2000; i++) metrics.request(i, "unknown-" + i, 1_000_000);
        assertEquals(initial, registry.getMeters().size());
        assertEquals(2000, registry.find("zenith.gateway.requests").timers().stream()
                .mapToLong(t -> t.count()).sum());
        for (var meter : registry.getMeters()) {
            assertNull(meter.getId().getTag("uri"));
            assertNull(meter.getId().getTag("clientIp"));
        }
    }
    @Test void diagnosticsCanDisableRequestMetersWithoutChangingReadiness() {
        var registry = new SimpleMeterRegistry();
        var metrics = new GatewayMetrics(registry, false, new ApplicationAvailabilityBean());
        metrics.request(200, "completed", 100);
        metrics.redis(0, 100);
        assertTrue(registry.find("zenith.gateway.requests").timers().isEmpty());
        assertTrue(registry.find("zenith.ratelimit.redis").timers().isEmpty());
        assertNotNull(registry.find("zenith.gateway.ready").gauge());
    }
}
