package com.zch.filter;

import com.zch.config.AdminAuthProperties;
import com.zch.config.CorsConfig;
import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;
import org.springframework.test.web.reactive.server.WebTestClient;
import org.springframework.http.HttpMethod;
import static org.junit.jupiter.api.Assertions.*;

class AdminAuthFilterTest {
    private AdminAuthProperties properties() {
        AdminAuthProperties properties = new AdminAuthProperties();
        properties.setToken("test-admin-credential");
        return properties;
    }
    private WebTestClient client(AdminAuthProperties properties) {
        return WebTestClient.bindToWebHandler(exchange -> exchange.getResponse().setComplete())
                .webFilter(new CorsConfig().corsWebFilter(),
                        new AdminAuthFilter(properties, new MockEnvironment())).configureClient().baseUrl("http://localhost").build();
    }

    @Test
    void requiresCredentialUnlessExplicitlyInDev() {
        assertThrows(IllegalStateException.class,
                () -> new AdminAuthFilter(new AdminAuthProperties(), new MockEnvironment()));
        assertDoesNotThrow(() -> new AdminAuthFilter(new AdminAuthProperties(),
                new MockEnvironment().withProperty("spring.profiles.active", "dev")));
        assertThrows(IllegalStateException.class, () -> new AdminAuthFilter(new AdminAuthProperties(),
                new MockEnvironment().withProperty("spring.profiles.active", "dev,prod")));
    }
    @Test
    void protectsManagementAndActuatorIncludingMatrixPaths() {
        var client = client(properties());
        for (String path : new String[]{"/settings", "/settings/runtime", "/settings;x=1/runtime",
                "/monitor/audit/recent", "/dashboard/snapshot", "/actuator/metrics"}) {
            client.get().uri(path).exchange().expectStatus().isUnauthorized();
        }
        client.get().uri("/actuator/health").exchange().expectStatus().isOk();
        client.get().uri("/public/api").exchange().expectStatus().isOk();
        client.get().uri("/settings/runtime").header("Authorization", "Bearer test-admin-credential")
                .exchange().expectStatus().isOk();
    }
    @Test
    void neverAcceptsAdminTokenInQueryAndScopesSseToken() {
        var properties = properties();
        var client = client(properties);
        client.get().uri("/settings/runtime?token=test-admin-credential")
                .exchange().expectStatus().isUnauthorized();
        client.get().uri("/monitor/stream?token=test-admin-credential")
                .exchange().expectStatus().isUnauthorized();
        client.get().uri("/monitor/stream?token=" + properties.getSseToken())
                .exchange().expectStatus().isOk();
        client.get().uri("/settings/runtime?token=" + properties.getSseToken())
                .exchange().expectStatus().isUnauthorized();
        client.get().uri("/settings/runtime").header("Authorization", "Bearer " + properties.getSseToken())
                .exchange().expectStatus().isUnauthorized();
    }
    @Test
    void permitsAllowedPreflightWithoutBypassingActualAuthentication() {
        var client = client(properties());
        client.options().uri("/settings/runtime").header("Origin", "http://localhost:5173")
                .header("Access-Control-Request-Method", HttpMethod.PUT.name())
                .header("Access-Control-Request-Headers", "authorization,content-type")
                .exchange().expectStatus().isOk()
                .expectHeader().valueEquals("Access-Control-Allow-Origin", "http://localhost:5173");
        client.get().uri("/settings/runtime").header("Origin", "http://localhost:5173")
                .exchange().expectStatus().isUnauthorized();
        client.options().uri("/settings/runtime").header("Origin", "https://untrusted.example")
                .header("Access-Control-Request-Method", "PUT").exchange().expectStatus().isForbidden();
    }

    @Test void scrapeCredentialCannotManageTheGateway() {
        var properties = properties();
        properties.setMetricsToken("metrics-only-test");
        var client = client(properties);
        client.get().uri("/actuator/prometheus").exchange().expectStatus().isUnauthorized();
        client.get().uri("/actuator/prometheus?token=metrics-only-test").exchange().expectStatus().isUnauthorized();
        client.get().uri("/actuator/prometheus").header("Authorization", "Bearer metrics-only-test")
                .exchange().expectStatus().isOk();
        client.get().uri("/actuator/prometheus").header("Authorization", "Bearer test-admin-credential")
                .exchange().expectStatus().isOk();
        for (String path : new String[]{"/settings/runtime", "/settings/routes", "/actuator/metrics",
                "/actuator/shutdown", "/monitor/stream", "/dashboard/snapshot"}) {
            client.get().uri(path).header("Authorization", "Bearer metrics-only-test")
                    .exchange().expectStatus().isUnauthorized();
        }
    }

    @Test void permitsOnlyTheTwoPublicProbeGroups() {
        var client = client(properties());
        client.get().uri("/actuator/health/readiness").exchange().expectStatus().isOk();
        client.get().uri("/actuator/health/liveness").exchange().expectStatus().isOk();
        client.get().uri("/actuator/health/redis").exchange().expectStatus().isUnauthorized();
    }

    @Test void devModeDoesNotExposeScrapesWithoutAnExplicitCredential() {
        var client = WebTestClient.bindToWebHandler(exchange -> exchange.getResponse().setComplete())
                .webFilter(new AdminAuthFilter(new AdminAuthProperties(),
                        new MockEnvironment().withProperty("spring.profiles.active", "dev"))).build();
        client.get().uri("/actuator/prometheus").exchange().expectStatus().isUnauthorized();
    }
}
