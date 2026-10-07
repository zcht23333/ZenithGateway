package com.zch.monitor;

import com.zch.config.GatewayRuntimeProperties;
import io.lettuce.core.ClientOptions;
import io.lettuce.core.RedisClient;
import io.lettuce.core.RedisURI;
import io.lettuce.core.ScriptOutputType;
import io.lettuce.core.TimeoutOptions;
import io.lettuce.core.api.StatefulRedisConnection;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import org.springframework.boot.data.redis.autoconfigure.DataRedisProperties;
import org.springframework.stereotype.Component;

/** Owns a separate bounded Lettuce connection. No offline buffering or reconnect replay. */
@Component
public class RedisAuditBatchWriter implements AuditBatchWriter {
    static final String SCRIPT = """
            if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
            local kind = redis.call('TYPE', KEYS[1]).ok
            if kind ~= 'none' and kind ~= 'list' then
              return redis.error_reply('audit list has wrong type')
            end
            local keep = tonumber(ARGV[1])
            local ttl = tonumber(ARGV[2])
            if not keep or keep < 1 or not ttl or ttl < 1 or #ARGV < 3 then
              return redis.error_reply('invalid audit arguments')
            end
            redis.call('LPUSH', KEYS[1], unpack(ARGV, 3))
            redis.call('LTRIM', KEYS[1], 0, keep - 1)
            redis.call('SET', KEYS[2], '1', 'EX', ttl)
            return 1
            """;
    private final GatewayRuntimeProperties.Audit config;
    private final RedisURI uri;
    private RedisClient client;
    private StatefulRedisConnection<String, String> connection;

    public RedisAuditBatchWriter(GatewayRuntimeProperties properties, DataRedisProperties redis) {
        config = properties.getAudit();
        config.validate();
        if (redis.getSentinel() != null || redis.getCluster() != null || redis.getMasterreplica() != null) {
            throw new IllegalArgumentException("Audit batch writer currently requires standalone Redis");
        }
        uri = redis.getUrl() == null ? RedisURI.create(redis.getHost(), redis.getPort()) : RedisURI.create(redis.getUrl());
        if (redis.getUrl() == null) {
            uri.setDatabase(redis.getDatabase());
            uri.setSsl(redis.getSsl().isEnabled());
            String password = redis.getPassword();
            if (redis.getUsername() != null) {
                uri.setAuthentication(redis.getUsername(), password == null ? "" : password);
            } else if (password != null && !password.isEmpty()) {
                uri.setAuthentication(password.toCharArray());
            }
        }
        if (!config.getHost().isBlank()) uri.setHost(config.getHost());
        if (config.getPort() != 0) uri.setPort(config.getPort());
        uri.setTimeout(Duration.ofMillis(config.getCommandTimeoutMs()));
    }

    @Override
    public void write(String batchId, List<String> payloads, Duration timeout) throws Exception {
        long deadline = System.nanoTime() + timeout.toNanos();
        if (client == null) {
            client = RedisClient.create(uri);
            client.setOptions(ClientOptions.builder()
                    .autoReconnect(false)
                    .disconnectedBehavior(ClientOptions.DisconnectedBehavior.REJECT_COMMANDS)
                    .requestQueueSize(8) // Includes Lettuce handshake commands; application has one batch in flight.
                    .timeoutOptions(TimeoutOptions.enabled(Duration.ofMillis(config.getCommandTimeoutMs())))
                    .socketOptions(io.lettuce.core.SocketOptions.builder()
                            .connectTimeout(Duration.ofMillis(config.getCommandTimeoutMs())).build())
                    .build());
        }
        try {
            if (connection == null || !connection.isOpen()) {
                var connecting = client.connectAsync(io.lettuce.core.codec.StringCodec.UTF8, uri);
                try {
                    connection = connecting.get(Math.max(1, deadline - System.nanoTime()), TimeUnit.NANOSECONDS);
                } catch (Exception failure) {
                    connecting.thenAccept(StatefulRedisConnection::close);
                    connecting.cancel(true);
                    throw failure;
                }
            }
            long remaining = deadline - System.nanoTime();
            if (remaining <= 0) throw new java.util.concurrent.TimeoutException("Audit command budget exhausted during connect");
            List<String> arguments = new ArrayList<>(payloads.size() + 2);
            arguments.add(Integer.toString(config.getRedisMaxEntries()));
            arguments.add(Long.toString(config.getDedupTtlSeconds()));
            arguments.addAll(payloads);
            Long result = connection.async().<Long>eval(SCRIPT, ScriptOutputType.INTEGER,
                    new String[] { config.getRedisKey(), config.getRedisKey() + ":batch:" + batchId },
                    arguments.toArray(String[]::new)).get(remaining, TimeUnit.NANOSECONDS);
            if (result == null || (result != 0 && result != 1)) throw new IllegalStateException("Unexpected audit script reply");
        } catch (Exception failure) {
            // Close on uncertain completion: no commands may be replayed beyond the dedup window.
            closeConnection();
            connection = null;
            throw failure;
        }
    }

    private void closeConnection() {
        if (connection == null) return;
        try { connection.closeAsync().get(1, TimeUnit.SECONDS); }
        catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
        catch (Exception failure) { org.slf4j.LoggerFactory.getLogger(getClass()).warn("Audit connection close not confirmed within 1s", failure); }
    }
    @Override
    public void close() {
        closeConnection();
        if (client != null) client.shutdown(Duration.ZERO, Duration.ofSeconds(1));
    }
}
