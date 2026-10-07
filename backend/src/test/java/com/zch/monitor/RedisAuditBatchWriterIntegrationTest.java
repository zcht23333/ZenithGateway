package com.zch.monitor;

import tools.jackson.databind.json.JsonMapper;
import com.zch.config.GatewayRuntimeProperties;
import io.lettuce.core.RedisClient;
import io.lettuce.core.api.StatefulRedisConnection;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.time.Duration;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.boot.data.redis.autoconfigure.DataRedisProperties;
import static org.awaitility.Awaitility.await;
import static org.junit.jupiter.api.Assertions.*;

@EnabledIfEnvironmentVariable(named = "ZENITH_TEST_REDIS_PORT", matches = "[0-9]+")
class RedisAuditBatchWriterIntegrationTest {
    private final GatewayRuntimeProperties properties = new GatewayRuntimeProperties();
    private final JsonMapper mapper = JsonMapper.builder().build();
    private RedisClient client;
    private StatefulRedisConnection<String, String> redis;
    private RedisAuditBatchWriter writer;

    @BeforeEach void setup() {
        var redisProperties = new DataRedisProperties();
        redisProperties.setHost("127.0.0.1");
        redisProperties.setPort(Integer.parseInt(System.getenv("ZENITH_TEST_REDIS_PORT")));
        properties.getAudit().setRedisKey("zg:test:audit:" + UUID.randomUUID());
        writer = new RedisAuditBatchWriter(properties, redisProperties);
        client = RedisClient.create("redis://127.0.0.1:" + redisProperties.getPort());
        redis = client.connect();
    }
    @AfterEach void close() {
        writer.close();
        var keys = redis.sync().keys(properties.getAudit().getRedisKey() + "*");
        if (!keys.isEmpty()) redis.sync().del(keys.toArray(String[]::new));
        redis.close(); client.shutdown();
    }

    @Test void lostAcknowledgementRetriesSameBatchWithoutDuplicates() {
        AtomicBoolean loseReply = new AtomicBoolean(true);
        AuditBatchWriter unreliable = (id, rows, timeout) -> {
            writer.write(id, rows, timeout);
            if (loseReply.getAndSet(false)) throw new java.net.SocketTimeoutException("Injected lost acknowledgement after Redis commit");
        };
        var publisher = new AuditEventPublisher(unreliable, mapper, properties, new SimpleMeterRegistry());
        publisher.start();
        try {
            for (int i = 0; i < 250; i++) publisher.publish(TrafficMetricsServiceTest.data(System.currentTimeMillis(), 10, 200));
            await().atMost(Duration.ofSeconds(10)).until(() -> publisher.status().pending() == 0);
            var rows = redis.sync().lrange(properties.getAudit().getRedisKey(), 0, -1);
            assertEquals(250, rows.size());
            assertEquals(250, rows.stream().map(row -> {
                try { return mapper.readTree(row).get("eventId").asString(); }
                catch (Exception e) { throw new RuntimeException(e); }
            }).distinct().count());
            assertEquals(250, publisher.status().persisted());
            assertTrue(publisher.status().retries() >= 1);
            AuditEventPublisherTest.assertReconciles(publisher.status());
        } finally { publisher.stop(); }
    }

    @Test void scriptKeepsNewestFirstTrimsAndAcceptsLegacyRecords() throws Exception {
        properties.getAudit().setRedisMaxEntries(3);
        String key = properties.getAudit().getRedisKey();
        redis.sync().lpush(key, "{\"timestamp\":1,\"method\":\"GET\",\"path\":\"/old\",\"statusCode\":200}");
        assertNull(mapper.readValue(redis.sync().lindex(key, 0), TrafficData.class).getEventId());
        writer.write("first", List.of("one", "two"), Duration.ofSeconds(1));
        writer.write("second", List.of("three", "four"), Duration.ofSeconds(1));
        writer.write("second", List.of("three", "four"), Duration.ofSeconds(1));
        assertEquals(List.of("four", "three", "two"), redis.sync().lrange(key, 0, -1));
        assertTrue(redis.sync().ttl(key + ":batch:second") > 100);
    }

    @Test void rejectedScriptDoesNotPoisonFutureBatches() throws Exception {
        String key = properties.getAudit().getRedisKey();
        redis.sync().set(key, "wrong type");
        assertThrows(Exception.class, () -> writer.write("bad", List.of("one"), Duration.ofSeconds(1)));
        assertEquals(0, redis.sync().exists(key + ":batch:bad"));
        redis.sync().del(key);
        writer.write("good", List.of("one"), Duration.ofSeconds(1));
        assertEquals(List.of("one"), redis.sync().lrange(key, 0, -1));
    }

    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(booleans = {false, true})
    void authenticatesWithAclCredentialsFromPropertiesOrUrl(boolean useUrl) throws Exception {
        String username = "audit-test-" + UUID.randomUUID();
        String password = "p@ss:/word";
        String key = properties.getAudit().getRedisKey();
        redis.sync().aclSetuser(username, new io.lettuce.core.AclSetuserArgs()
                .on().addPassword(password).keyPattern(key + "*").allCommands());
        var connection = new DataRedisProperties();
        connection.setHost("127.0.0.1");
        connection.setPort(Integer.parseInt(System.getenv("ZENITH_TEST_REDIS_PORT")));
        if (useUrl) {
            connection.setUrl("redis://" + username + ":p%40ss%3A%2Fword@127.0.0.1:" + connection.getPort());
            connection.setPassword("ignored-when-url-is-set");
        } else {
            connection.setUsername(username);
            connection.setPassword(password);
        }
        var authenticated = new RedisAuditBatchWriter(properties, connection);
        try {
            authenticated.write("authenticated", List.of("event"), Duration.ofSeconds(2));
            assertEquals(List.of("event"), redis.sync().lrange(key, 0, -1));
        } finally {
            authenticated.close();
            redis.sync().aclDeluser(username);
        }
    }
    @Test void rejectsMasterReplicaConfigurationInsteadOfWritingToTheDefaultHost() {
        var connection = new DataRedisProperties();
        connection.setMasterreplica(new DataRedisProperties.Masterreplica());
        assertThrows(IllegalArgumentException.class, () -> new RedisAuditBatchWriter(properties, connection));
    }
}
