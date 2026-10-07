package com.zch.route;

import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.time.Duration;
import java.util.Map;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.data.redis.core.ReactiveStringRedisTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.reactive.server.WebTestClient;
import static org.awaitility.Awaitility.await;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "zenith.admin.token=integration-test-token",
        "zenith.rate-limit.enabled=false",
        "zenith.route.redis-key=zg:integration:routes",
        "zenith.runtime.redis-key=zg:integration:runtime",
        "zenith.audit.redis-key=zg:integration:audit"
})
@EnabledIfEnvironmentVariable(named = "ZENITH_TEST_REDIS_PORT", matches = "[0-9]+")
class GatewayRedisIntegrationTest {
    @LocalServerPort int port;
    @Autowired ReactiveStringRedisTemplate redis;
    private static final String KEY_PREFIX = "zg:integration:" + java.util.UUID.randomUUID();
    private static HttpServer upstream;
    private static final java.util.concurrent.CountDownLatch cancelEntered = new java.util.concurrent.CountDownLatch(1);

    @DynamicPropertySource
    static void redisPort(DynamicPropertyRegistry registry) {
        registry.add("spring.data.redis.port", () -> System.getenv("ZENITH_TEST_REDIS_PORT"));
        registry.add("spring.data.redis.host", () -> "127.0.0.1");
        registry.add("zenith.route.redis-key", () -> KEY_PREFIX + ":routes");
        registry.add("zenith.runtime.redis-key", () -> KEY_PREFIX + ":runtime");
        registry.add("zenith.audit.redis-key", () -> KEY_PREFIX + ":audit");
        registry.add("zenith.limiter.namespace", () -> KEY_PREFIX + ":limiter");
    }
    @BeforeAll
    static void startUpstream() throws Exception {
        upstream = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        upstream.setExecutor(java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor());
        upstream.createContext("/", exchange -> {
            byte[] body = exchange.getRequestURI().getPath().getBytes(java.nio.charset.StandardCharsets.UTF_8);
            String path = exchange.getRequestURI().getPath();
            if (path.endsWith("cancel")) cancelEntered.countDown();
            if (path.endsWith("slow") || path.endsWith("cancel")) {
                try { Thread.sleep(4000); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
            }
            exchange.sendResponseHeaders(path.endsWith("error") ? 500 : 200, body.length);
            try (var out = exchange.getResponseBody()) { out.write(body); }
        });
        upstream.start();
    }
    @AfterAll
    static void stopUpstream() { if (upstream != null) upstream.stop(0); }

    @Test
    void realRedisRouteRewriteAndLuaLimiterRejectSpoofedClientHeaders() {
        var client = WebTestClient.bindToServer().baseUrl("http://127.0.0.1:" + port).build();
        String auth = "Bearer integration-test-token";
        client.options().uri("/settings/routes").header("Origin", "http://127.0.0.1:5173")
                .header("Access-Control-Request-Method", "POST")
                .header("Access-Control-Request-Headers", "authorization,content-type")
                .exchange().expectStatus().isOk()
                .expectHeader().valueEquals("Access-Control-Allow-Origin", "http://127.0.0.1:5173");
        saveRuntime(client, Map.of("rateLimitEnabled", false));
        client.post().uri("/settings/routes").header("Authorization", auth)
                .header("Origin", "http://127.0.0.1:5173")
                .bodyValue(routeRequest(client,Map.of("id", "integration", "path", "/integration/**",
                        "uri", "http://127.0.0.1:" + upstream.getAddress().getPort(),
                        "rewriteEnabled", true, "circuitBreakerEnabled", false)))
                .exchange().expectStatus().isCreated();
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() ->
                client.get().uri("/integration/hello").exchange().expectStatus().isOk()
                        .expectBody(String.class).isEqualTo("/hello"));

        // Only run against the dedicated disposable Redis instance documented in the README.
        redis.delete(KEY_PREFIX + ":limiter:bucket:127.0.0.1").block();
        saveRuntime(client, Map.of("rateLimitEnabled", true, "replenishRate", 1, "burstCapacity", 1, "requestedTokens", 1));
        client.get().uri("/integration/hello").header("X-Forwarded-For", "203.0.113.1")
                .exchange().expectStatus().isOk();
        client.get().uri("/integration/hello").header("X-Forwarded-For", "203.0.113.2")
                .exchange().expectStatus().isEqualTo(429);
        client.post().uri("/settings/routes").header("Authorization", auth)
                .header("Origin", "http://127.0.0.1:5173")
                .bodyValue(routeRequest(client,Map.of("id", "invalid", "path", "/invalid/**", "uri", "/relative")))
                .exchange().expectStatus().isBadRequest();
        client.get().uri("/settings/routes").exchange().expectStatus().isUnauthorized();
        client.method(org.springframework.http.HttpMethod.DELETE).uri("/settings/routes/integration").header("Authorization", auth).bodyValue(Map.of("expectedVersion",routeVersion(client)))
                .exchange().expectStatus().isOk();
        redis.delete(KEY_PREFIX + ":limiter:bucket:127.0.0.1").block();
    }

    @Autowired com.zch.monitor.AuditEventPublisher audit;
    @Autowired com.zch.monitor.TrafficMetricsService metrics;
    @Autowired tools.jackson.databind.json.JsonMapper mapper;

    @Test
    void actualGatewayErrorsTimeoutFallbackAndCancellationAreRecordedOnce() throws Exception {
        var client = WebTestClient.bindToServer().baseUrl("http://127.0.0.1:" + port)
                .responseTimeout(Duration.ofSeconds(8)).build();
        String auth = "Bearer integration-test-token";
        saveRuntime(client, Map.of("rateLimitEnabled", false));
        for (String id : java.util.List.of("outcomes", "timed")) {
            client.post().uri("/settings/routes").header("Authorization", auth)
                    .bodyValue(routeRequest(client,Map.of("id", id, "path", "/" + id + "/**",
                            "uri", "http://127.0.0.1:" + upstream.getAddress().getPort(),
                            "rewriteEnabled", false, "circuitBreakerEnabled", id.equals("timed"),
                            "circuitBreakerName", "default", "fallbackPath", "/fallback/default")))
                    .exchange().expectStatus().isCreated();
        }
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() ->
                client.get().uri("/outcomes/ready").exchange().expectStatus().isOk());
        await().atMost(Duration.ofSeconds(5)).until(() -> audit.status().pending() == 0);
        long before = metrics.latestSnapshot().getCompletedTotal();
        long auditBefore = audit.status().received();
        client.get().uri("/outcomes/error").exchange().expectStatus().isEqualTo(500);
        client.get().uri("/timed/slow").exchange().expectStatus().isEqualTo(504);
        var subscription = reactor.netty.http.client.HttpClient.create()
                .get().uri("http://127.0.0.1:" + port + "/outcomes/cancel")
                .response().subscribe();
        org.junit.jupiter.api.Assertions.assertTrue(cancelEntered.await(3, java.util.concurrent.TimeUnit.SECONDS));
        subscription.dispose();
        await().atMost(Duration.ofSeconds(8)).untilAsserted(() -> {
            org.junit.jupiter.api.Assertions.assertEquals(before + 3, metrics.latestSnapshot().getCompletedTotal());
            org.junit.jupiter.api.Assertions.assertEquals(auditBefore + 3, audit.status().received());
            org.junit.jupiter.api.Assertions.assertEquals(0, audit.status().pending());
        });
        var rows = redis.opsForList().range(KEY_PREFIX + ":audit", 0, -1).collectList().block();
        var events = new java.util.ArrayList<com.zch.monitor.TrafficData>();
        for (String row : rows) events.add(mapper.readValue(row, com.zch.monitor.TrafficData.class));
        for (String path : java.util.List.of("/outcomes/error", "/timed/slow", "/outcomes/cancel"))
            org.junit.jupiter.api.Assertions.assertEquals(1, events.stream().filter(e -> path.equals(e.getPath())).count());
        org.junit.jupiter.api.Assertions.assertEquals(500, events.stream()
                .filter(e -> "/outcomes/error".equals(e.getPath())).findFirst().orElseThrow().getStatusCode());
        org.junit.jupiter.api.Assertions.assertEquals(504, events.stream()
                .filter(e -> "/timed/slow".equals(e.getPath())).findFirst().orElseThrow().getStatusCode());
        var cancelled = events.stream().filter(e -> "/outcomes/cancel".equals(e.getPath())).findFirst().orElseThrow();
        org.junit.jupiter.api.Assertions.assertEquals("cancelled", cancelled.getOutcome());
        org.junit.jupiter.api.Assertions.assertEquals(0, cancelled.getStatusCode());
        for (String id : java.util.List.of("outcomes", "timed"))
            client.method(org.springframework.http.HttpMethod.DELETE).uri("/settings/routes/" + id).header("Authorization", auth).bodyValue(Map.of("expectedVersion",routeVersion(client))).exchange().expectStatus().isOk();
    }

    private String fixture(String name) throws Exception {
        try (var input = getClass().getResourceAsStream("/compatibility/" + name + ".json")) {
            return new String(java.util.Objects.requireNonNull(input).readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
        }
    }

    @Autowired DynamicRouteService routes;
    @Autowired com.zch.config.RuntimeConfigPersistence runtimePersistence;
    @Autowired com.zch.config.GatewayRuntimeProperties runtimeProperties;

    @Test
    void legacyRouteStillValidatesButCannotBypassPublication() throws Exception {
        var legacy = mapper.readValue(fixture("route-boot3"), RouteRuleDto.class);
        org.junit.jupiter.api.Assertions.assertEquals("legacy-route", RouteValidator.normalize(legacy).getId());
        var client = WebTestClient.bindToServer().baseUrl("http://127.0.0.1:" + port).build();
        client.post().uri("/settings/routes").header("Authorization", "Bearer integration-test-token")
                .bodyValue(legacy).exchange().expectStatus().isEqualTo(428);
    }
    private String routeVersion(WebTestClient client) {
        var body=client.get().uri("/settings/routes").header("Authorization","Bearer integration-test-token")
                .exchange().expectStatus().isOk().expectBody(Map.class).returnResult().getResponseBody();
        return (String)body.get("version");
    }
    private Map<String,Object> routeRequest(WebTestClient client,Map<String,Object> route){return Map.of("expectedVersion",routeVersion(client),"route",route);}

    @SuppressWarnings("unchecked")
    private void saveRuntime(WebTestClient client, Map<String, Object> changes) {
        var current = client.get().uri("/settings/runtime").header("Authorization", "Bearer integration-test-token")
                .exchange().expectStatus().isOk().expectBody(Map.class).returnResult().getResponseBody();
        var request = new java.util.LinkedHashMap<String, Object>(current);
        request.put("expectedVersion", current.get("version")); request.put("operationId", java.util.UUID.randomUUID().toString());
        request.putAll(changes);
        client.put().uri("/settings/runtime").header("Authorization", "Bearer integration-test-token")
                .bodyValue(request).exchange().expectStatus().isOk();
    }

    @Test
    void legacyRuntimeMigratesOnItsOwnKeyWithoutChangingSixValues() throws Exception {
        String key = KEY_PREFIX + ":legacy-runtime";
        var properties = new com.zch.config.GatewayRuntimeProperties();
        var persistence = new com.zch.config.RuntimeConfigPersistence(redis, mapper, properties);
        org.springframework.test.util.ReflectionTestUtils.setField(persistence, "redisKey", key);
        String json = fixture("runtime-boot3");
        try {
            redis.opsForValue().set(key, json).block();
            persistence.run(new org.springframework.boot.DefaultApplicationArguments());
            org.junit.jupiter.api.Assertions.assertEquals(mapper.readTree(json), mapper.valueToTree(properties.snapshot().values()));
            var stored = mapper.readTree(redis.opsForValue().get(key).block());
            org.junit.jupiter.api.Assertions.assertEquals(3, stored.get("schemaVersion").asInt());
            org.junit.jupiter.api.Assertions.assertEquals(properties.snapshot().version(), stored.get("version").asString());
            var previous = properties.snapshot();
            var saved = persistence.persist(java.util.UUID.randomUUID().toString(), previous.version(), previous).block();
            org.junit.jupiter.api.Assertions.assertEquals(previous.revision() + 1, saved.snapshot().revision());
        } finally { redis.delete(key).block(); }
    }

    @Test
    void auditJsonRetainsNumbersNullsUnicodeAndSupportsPreEventIdRecords() throws Exception {
        String json = fixture("audit-boot3");
        var event = mapper.readValue(json, com.zch.monitor.AuditEvent.class);
        org.junit.jupiter.api.Assertions.assertEquals(1790123456789L, event.timestamp());
        org.junit.jupiter.api.Assertions.assertEquals(mapper.readTree(json), mapper.readTree(mapper.writeValueAsString(event)));
        var old = mapper.readValue(fixture("audit-v1"), com.zch.monitor.TrafficData.class);
        org.junit.jupiter.api.Assertions.assertNull(old.getEventId());
        org.junit.jupiter.api.Assertions.assertNull(old.getOutcome());
        org.junit.jupiter.api.Assertions.assertEquals(200, old.getStatusCode());
        var cancelled = new com.zch.monitor.AuditEvent("cancel:1", 1790123456789L, "GET", "/legacy/cancel", 0, 4, null, "cancelled");
        var roundTrip = mapper.readValue(mapper.writeValueAsString(cancelled), com.zch.monitor.TrafficData.class);
        org.junit.jupiter.api.Assertions.assertEquals(0, roundTrip.getStatusCode());
        org.junit.jupiter.api.Assertions.assertNull(roundTrip.getClientIp());
        org.junit.jupiter.api.Assertions.assertEquals("cancelled", roundTrip.getOutcome());
    }
}
