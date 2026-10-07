package com.zch.config;

import io.lettuce.core.ClientOptions;
import io.lettuce.core.RedisClient;
import io.lettuce.core.RedisURI;
import io.lettuce.core.ScriptOutputType;
import io.lettuce.core.SocketOptions;
import io.lettuce.core.TimeoutOptions;
import io.lettuce.core.api.StatefulRedisConnection;
import io.lettuce.core.codec.StringCodec;
import java.time.Duration;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.data.redis.autoconfigure.DataRedisProperties;
import org.springframework.stereotype.Component;

/** One bounded connection; disconnected commands are rejected, never buffered or replayed. */
@Component
public class RedisRuntimeConfigSyncReader implements RuntimeConfigSyncReader {
    private final RedisURI uri;
    private final String key;
    private final RuntimeConfigPersistence persistence;
    private RedisClient client;
    private StatefulRedisConnection<String, String> connection;
    private boolean closed;

    public RedisRuntimeConfigSyncReader(DataRedisProperties redis, RuntimeConfigSyncProperties config,
            RuntimeConfigPersistence persistence, @Value("${zenith.runtime.redis-key:zg:runtime:config}") String key) {
        config.validate();
        if (redis.getSentinel() != null || redis.getCluster() != null || redis.getMasterreplica() != null)
            throw new IllegalArgumentException("Runtime configuration sync currently requires standalone Redis");
        uri = redis.getUrl() == null ? RedisURI.create(redis.getHost(), redis.getPort()) : RedisURI.create(redis.getUrl());
        if (redis.getUrl() == null) {
            uri.setDatabase(redis.getDatabase());
            uri.setSsl(redis.getSsl().isEnabled());
            String password = redis.getPassword();
            if (redis.getUsername() != null) uri.setAuthentication(redis.getUsername(), password == null ? "" : password);
            else if (password != null && !password.isEmpty()) uri.setAuthentication(password.toCharArray());
        }
        uri.setTimeout(Duration.ofMillis(config.getTimeoutMs()));
        uri.setClientName("zenith-runtime-sync:" + config.getInstanceId());
        this.key = key;
        this.persistence = persistence;
    }

    @Override
    public RuntimeConfigSnapshot read(Duration budget) throws Exception {
        long deadline = System.nanoTime() + budget.toNanos();
        try {
            RedisClient currentClient;
            StatefulRedisConnection<String, String> currentConnection;
            synchronized (this) {
                if (closed) throw new IllegalStateException("Sync reader is closed");
                if (client == null) {
                    client = RedisClient.create(uri);
                    client.setOptions(ClientOptions.builder().autoReconnect(false).requestQueueSize(8)
                            .disconnectedBehavior(ClientOptions.DisconnectedBehavior.REJECT_COMMANDS)
                            .timeoutOptions(TimeoutOptions.enabled(budget))
                            .socketOptions(SocketOptions.builder().connectTimeout(budget).build()).build());
                }
                currentClient = client;
                currentConnection = connection;
            }
            if (currentConnection == null || !currentConnection.isOpen()) {
                var connecting = currentClient.connectAsync(StringCodec.UTF8, uri);
                try { currentConnection = connecting.get(remaining(deadline), TimeUnit.NANOSECONDS); }
                catch (Exception error) {
                    connecting.thenAccept(StatefulRedisConnection::closeAsync);
                    connecting.cancel(true);
                    throw error;
                }
                synchronized (this) {
                    if (closed) {
                        currentConnection.closeAsync();
                        throw new IllegalStateException("Sync reader closed during connection");
                    }
                    connection = currentConnection;
                }
            }
            // Reuse the authority's exact validation script, in read mode only.
            var pending = currentConnection.async().<String>eval(RuntimeConfigPersistence.storageScript(),
                    ScriptOutputType.VALUE, new String[]{key}, "read", "", "{}");
            String reply;
            try { reply = pending.get(remaining(deadline), TimeUnit.NANOSECONDS); }
            catch (Exception error) { pending.cancel(true); throw error; }
            return persistence.decodeReadReply(reply);
        } catch (Exception error) {
            discardConnection();
            throw error;
        }
    }

    private static long remaining(long deadline) throws TimeoutException {
        long remaining = deadline - System.nanoTime();
        if (remaining <= 0) throw new TimeoutException("Runtime sync read budget exhausted");
        return remaining;
    }

    private void discardConnection() {
        StatefulRedisConnection<String, String> old;
        synchronized (this) { old = connection; connection = null; }
        if (old != null) old.closeAsync();
    }

    @Override
    public void close() {
        RedisClient old;
        synchronized (this) {
            if (closed) return;
            closed = true; old = client; client = null;
        }
        discardConnection();
        if (old != null) old.shutdown(Duration.ZERO, Duration.ofSeconds(1));
    }
}
