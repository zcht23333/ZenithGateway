package com.zch.config;

import io.lettuce.core.RedisClient;
import java.time.Duration;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.boot.data.redis.autoconfigure.DataRedisProperties;
import tools.jackson.databind.json.JsonMapper;
import static org.junit.jupiter.api.Assertions.*;
import static com.zch.config.RuntimeConfigConcurrencyTest.snapshot;

@EnabledIfEnvironmentVariable(named = "ZENITH_TEST_REDIS_PORT", matches = "[0-9]+")
class RedisRuntimeConfigSyncReaderIntegrationTest {
    @Test void realReadUsesAuthorityValidationNeverInitializesOrWritesAndReleasesItsNamedConnection() throws Exception {
        var config = new RuntimeConfigSyncProperties();
        var redis = new DataRedisProperties();
        redis.setHost("127.0.0.1"); redis.setPort(Integer.parseInt(System.getenv("ZENITH_TEST_REDIS_PORT")));
        String key = "zg:test:sync-reader:" + UUID.randomUUID();
        var mapper = JsonMapper.builder().build();
        var properties = new GatewayRuntimeProperties(); properties.adopt(snapshot(1));
        var persistence = new RuntimeConfigPersistence(null, mapper, properties);
        var client = RedisClient.create("redis://127.0.0.1:" + redis.getPort());
        try (var inspect = client.connect();
             var reader = new RedisRuntimeConfigSyncReader(redis, config, persistence, key)) {
            var missing = assertThrows(ConfigProblem.class, () -> reader.read(Duration.ofSeconds(1)));
            assertEquals("CONFIG_STORAGE_MISSING", missing.response().get("code")); assertNull(inspect.sync().get(key));
            var value = snapshot(2).response(); value.put("schemaVersion", 3); value.put("operations", java.util.Map.of()); value.put("history", java.util.List.of());
            String original = mapper.writeValueAsString(value); inspect.sync().set(key, original);
            assertEquals(snapshot(2), reader.read(Duration.ofSeconds(1)));
            assertEquals(snapshot(2), reader.read(Duration.ofSeconds(1)));
            assertEquals(original, inspect.sync().get(key));
            assertEquals(snapshot(1), properties.snapshot(), "reader must not bypass the sync publication gate");
            assertEquals(1, inspect.sync().clientList().lines().filter(s -> s.contains("zenith-runtime-sync:" + config.getInstanceId())).count());
            inspect.sync().set(key, "{\"rateLimitEnabled\":true}");
            var invalid = assertThrows(ConfigProblem.class, () -> reader.read(Duration.ofSeconds(1)));
            assertEquals("CONFIG_STORAGE_INVALID", invalid.response().get("code"));
            assertEquals("{\"rateLimitEnabled\":true}", inspect.sync().get(key));
            reader.close(); reader.close();
            assertThrows(IllegalStateException.class, () -> reader.read(Duration.ofSeconds(1)));
            assertEquals(0, inspect.sync().clientList().lines().filter(s -> s.contains("zenith-runtime-sync:" + config.getInstanceId())).count());
            inspect.sync().del(key);
        } finally { client.shutdown(); }
    }
}
