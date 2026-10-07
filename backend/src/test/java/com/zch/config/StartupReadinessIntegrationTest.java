package com.zch.config;

import com.zch.GatewayApplication;
import io.lettuce.core.RedisClient;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.UUID;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.context.event.ApplicationStartedEvent;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.ApplicationListener;
import org.springframework.context.annotation.Bean;
import org.springframework.core.Ordered;
import static org.junit.jupiter.api.Assertions.*;

@EnabledIfEnvironmentVariable(named = "ZENITH_TEST_REDIS_PORT", matches = "[0-9]+")
class StartupReadinessIntegrationTest {
    private static final CountDownLatch entered = new CountDownLatch(1);
    private static final CountDownLatch release = new CountDownLatch(1);

    @Test void boundServerRejectsRequestsUntilPersistedConfigurationHasBeenRestored() throws Exception {
        String key = "zg:test:startup:" + UUID.randomUUID();
        String redisPort = System.getenv("ZENITH_TEST_REDIS_PORT");
        var redis = RedisClient.create("redis://127.0.0.1:" + redisPort);
        var connection = redis.connect();
        connection.sync().set(key, "{\"rateLimitEnabled\":true,\"replenishRate\":37,\"burstCapacity\":40,\"requestedTokens\":1,\"monitorWindowSeconds\":10,\"emitIntervalSeconds\":1}");
        var executor = Executors.newSingleThreadExecutor();
        var port = new AtomicInteger();
        var sync = new java.util.concurrent.atomic.AtomicReference<RuntimeConfigSync>();
        var app = new SpringApplication(GatewayApplication.class, SlowStartup.class);
        app.addListeners((ApplicationListener<ApplicationStartedEvent>) event -> {
            port.set(event.getApplicationContext().getEnvironment().getRequiredProperty("local.server.port", Integer.class));
            sync.set(event.getApplicationContext().getBean(RuntimeConfigSync.class));
        });
        var started = executor.submit(() -> app.run("--server.port=0", "--server.address=127.0.0.1",
                "--spring.data.redis.host=127.0.0.1", "--spring.data.redis.port=" + redisPort,
                "--spring.data.redis.password=", "--zenith.admin.token=startup-test",
                "--zenith.runtime.redis-key=" + key, "--zenith.route.redis-key=" + key + ":routes",
                "--zenith.audit.enabled=false"));
        try {
            assertTrue(entered.await(30, TimeUnit.SECONDS), "Startup runner did not start");
            var client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();
            String base = "http://127.0.0.1:" + port.get();
            assertEquals(503, get(client, base + "/actuator/health/readiness").statusCode());
            assertEquals(503, get(client, base + "/settings/runtime").statusCode());
            assertEquals(503, get(client, base + "/not-a-route").statusCode());
            assertEquals(false, sync.get().status().get("running"));
            assertEquals(0L, sync.get().status().get("checksStarted"));
            release.countDown();
            started.get(30, TimeUnit.SECONDS);
            org.awaitility.Awaitility.await().atMost(Duration.ofSeconds(5)).untilAsserted(() ->
                    assertEquals("ok", sync.get().status().get("status")));
            assertEquals(200, get(client, base + "/actuator/health/readiness").statusCode());
            var settings = get(client, base + "/settings/runtime");
            assertEquals(200, settings.statusCode());
            assertTrue(settings.body().contains("\"replenishRate\":37"), settings.body());
            assertEquals(404, get(client, base + "/not-a-route").statusCode());
        } finally {
            release.countDown();
            try {
                started.get(30, TimeUnit.SECONDS).close();
                assertEquals("stopped", sync.get().status().get("status"));
            }
            finally {
                executor.shutdownNow();
                connection.sync().del(key, key + ":routes");
                connection.close();
                redis.shutdown();
            }
        }
    }

    private HttpResponse<String> get(HttpClient client, String url) throws Exception {
        return client.send(HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(5))
                .header("Authorization", "Bearer startup-test").GET().build(), HttpResponse.BodyHandlers.ofString());
    }

    @TestConfiguration(proxyBeanMethods = false)
    static class SlowStartup {
        @Bean BlockingRunner blockStartup() { return new BlockingRunner(); }
    }

    static class BlockingRunner implements ApplicationRunner, Ordered {
        @Override public int getOrder() { return Ordered.HIGHEST_PRECEDENCE; }
        @Override public void run(ApplicationArguments args) throws Exception {
            entered.countDown();
            if (!release.await(30, TimeUnit.SECONDS)) throw new IllegalStateException("Test startup was not released");
        }
    }
}
