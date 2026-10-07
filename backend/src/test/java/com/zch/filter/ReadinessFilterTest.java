package com.zch.filter;

import com.zch.config.AdminAuthProperties;
import org.junit.jupiter.api.Test;
import org.springframework.boot.availability.ApplicationAvailabilityBean;
import org.springframework.boot.availability.AvailabilityChangeEvent;
import org.springframework.boot.availability.ReadinessState;
import org.springframework.mock.env.MockEnvironment;
import org.springframework.test.web.reactive.server.WebTestClient;
import static org.junit.jupiter.api.Assertions.*;

class ReadinessFilterTest {
    @Test void rejectsTrafficBeforeReadinessAndAfterRefusingTraffic() {
        var availability = new ApplicationAvailabilityBean();
        var client = WebTestClient.bindToWebHandler(exchange -> exchange.getResponse().setComplete())
                .webFilter(new ReadinessFilter(availability, com.zch.lifecycle.TrafficLifecycleTest.lifecycle(availability))).build();
        client.get().uri("/business").exchange().expectStatus().isEqualTo(503)
                .expectHeader().valueEquals("Retry-After", "1");
        client.get().uri("/settings/runtime").exchange().expectStatus().isEqualTo(503);
        availability.onApplicationEvent(new AvailabilityChangeEvent<>(this, ReadinessState.ACCEPTING_TRAFFIC));
        client.get().uri("/business").exchange().expectStatus().isOk();
        availability.onApplicationEvent(new AvailabilityChangeEvent<>(this, ReadinessState.REFUSING_TRAFFIC));
        client.get().uri("/business").exchange().expectStatus().isEqualTo(503);
    }

    @Test void healthAndAuthenticatedScrapingRemainAvailableDuringStartup() {
        var properties = new AdminAuthProperties();
        properties.setToken("admin-test");
        properties.setMetricsToken("scrape-test");
        var client = WebTestClient.bindToWebHandler(exchange -> exchange.getResponse().setComplete())
                .webFilter(new AdminAuthFilter(properties, new MockEnvironment()),
                        new ReadinessFilter(new ApplicationAvailabilityBean(), com.zch.lifecycle.TrafficLifecycleTest.lifecycle(new ApplicationAvailabilityBean()))).build();
        client.get().uri("/actuator/health/readiness").exchange().expectStatus().isOk();
        client.get().uri("/actuator/prometheus").exchange().expectStatus().isUnauthorized();
        client.get().uri("/actuator/prometheus").header("Authorization", "Bearer scrape-test")
                .exchange().expectStatus().isOk();
        client.get().uri("/settings/runtime").exchange().expectStatus().isUnauthorized();
        client.get().uri("/settings/runtime").header("Authorization", "Bearer admin-test")
                .exchange().expectStatus().isEqualTo(503);
    }
    @Test void drainingKeepsOnlyAuthenticatedLocalDiagnosticsAndIdempotentDrainControl() throws Exception {
        var availability = new ApplicationAvailabilityBean();
        availability.onApplicationEvent(new AvailabilityChangeEvent<>(this, ReadinessState.ACCEPTING_TRAFFIC));
        var lifecycle = com.zch.lifecycle.TrafficLifecycleTest.lifecycle(availability);
        lifecycle.beginDrain().get(2, java.util.concurrent.TimeUnit.SECONDS);
        var properties = new AdminAuthProperties(); properties.setToken("admin-test");
        var client = WebTestClient.bindToWebHandler(exchange -> exchange.getResponse().setComplete())
                .webFilter(new AdminAuthFilter(properties, new MockEnvironment()),new ReadinessFilter(availability,lifecycle)).build();
        client.get().uri("/settings/lifecycle").exchange().expectStatus().isUnauthorized();
        client.post().uri("/settings/lifecycle/drain").exchange().expectStatus().isUnauthorized();
        for (String path : java.util.List.of("/settings/lifecycle","/settings/runtime/sync","/settings/routes/adopted","/monitor/audit/status"))
            client.get().uri(path).header("Authorization","Bearer admin-test").exchange().expectStatus().isOk();
        client.post().uri("/settings/lifecycle/drain").header("Authorization","Bearer admin-test").exchange().expectStatus().isOk();
        client.put().uri("/settings/runtime").header("Authorization","Bearer admin-test").exchange().expectStatus().isEqualTo(503);
        client.get().uri("/settings/runtime").header("Authorization","Bearer admin-test").exchange().expectStatus().isEqualTo(503);
        client.get().uri("/business").exchange().expectStatus().isEqualTo(503).expectHeader().valueEquals("Connection","close");
        client.get().uri("/actuator/health/liveness").exchange().expectStatus().isOk();
    }
}
