package com.zch.config;

import java.util.concurrent.atomic.AtomicReference;
import java.time.Clock;
import java.time.Instant;
import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "zenith")
public class GatewayRuntimeProperties {

    public record Adoption(RuntimeConfigSnapshot snapshot, Instant adoptedAt) {}
    private final Clock clock;
    private final AtomicReference<Adoption> runtime = new AtomicReference<>(new Adoption(
            new RuntimeConfigSnapshot(null, RateLimitConfig.defaults(), MonitorConfig.defaults()), null));
    public GatewayRuntimeProperties() { this(Clock.systemUTC()); }
    GatewayRuntimeProperties(Clock clock) { this.clock = clock; }
    private final Audit audit = new Audit();
    private final Route route = new Route();

    public Adoption adoption() { return runtime.get(); }
    public RuntimeConfigSnapshot snapshot() { return adoption().snapshot(); }
    public RateLimitConfig getRateLimit() { return snapshot().rateLimit(); }
    public MonitorConfig getMonitor() { return snapshot().monitor(); }

    // Spring property binding is startup-only, before storage establishes a version.
    public void setRateLimit(RateLimitConfig value) {
        runtime.updateAndGet(adoption -> {
            var current = adoption.snapshot();
            requireUninitialized(current);
            return new Adoption(new RuntimeConfigSnapshot(null, value, current.monitor()), null);
        });
    }
    public void setMonitor(MonitorConfig value) {
        runtime.updateAndGet(adoption -> {
            var current = adoption.snapshot();
            requireUninitialized(current);
            return new Adoption(new RuntimeConfigSnapshot(null, current.rateLimit(), value), null);
        });
    }
    private void requireUninitialized(RuntimeConfigSnapshot current) {
        if (current.version() != null) throw new IllegalStateException("Use a confirmed whole snapshot after startup");
    }

    public RuntimeConfigSnapshot adopt(RuntimeConfigSnapshot next) {
        if (next.version() == null) throw new IllegalArgumentException("Cannot adopt an unversioned snapshot");
        return runtime.updateAndGet(adoption -> {
            var current = adoption.snapshot();
            if (current.version() == null) return new Adoption(next, clock.instant());
            if (!current.epoch().equals(next.epoch()))
                throw new IllegalStateException("Storage generation changed; controlled restart required");
            if (next.revision() < current.revision()) return adoption;
            if (next.revision() == current.revision() && !next.equals(current))
                throw new IllegalStateException("Different values for the same configuration version");
            if (next.equals(current)) return adoption;
            return new Adoption(next, clock.instant());
        }).snapshot();
    }

    // ─── 只读配置（不变） ───

    public Audit getAudit() {
        return audit;
    }

    public Route getRoute() {
        return route;
    }

    // ─── 内部配置类 ───

    public static class Audit {
        private long bufferMaxBytes = 16 * 1024 * 1024L;
        public long getBufferMaxBytes() { return bufferMaxBytes; }
        public void setBufferMaxBytes(long value) { bufferMaxBytes = value; }
        private int eventMaxBytes = 64 * 1024;
        public int getEventMaxBytes() { return eventMaxBytes; }
        public void setEventMaxBytes(int value) { eventMaxBytes = value; }
        private int batchSize = 100;
        public int getBatchSize() { return batchSize; }
        public void setBatchSize(int value) { batchSize = value; }
        private int batchMaxBytes = 256 * 1024;
        public int getBatchMaxBytes() { return batchMaxBytes; }
        public void setBatchMaxBytes(int value) { batchMaxBytes = value; }
        private long flushIntervalMs = 20;
        public long getFlushIntervalMs() { return flushIntervalMs; }
        public void setFlushIntervalMs(long value) { flushIntervalMs = value; }
        private long commandTimeoutMs = 1000;
        public long getCommandTimeoutMs() { return commandTimeoutMs; }
        public void setCommandTimeoutMs(long value) { commandTimeoutMs = value; }
        private long retryMaxElapsedMs = 10000;
        public long getRetryMaxElapsedMs() { return retryMaxElapsedMs; }
        public void setRetryMaxElapsedMs(long value) { retryMaxElapsedMs = value; }
        private long dedupTtlSeconds = 120;
        public long getDedupTtlSeconds() { return dedupTtlSeconds; }
        public void setDedupTtlSeconds(long value) { dedupTtlSeconds = value; }
        private long shutdownDrainTimeoutMs = 5000;
        public long getShutdownDrainTimeoutMs() { return shutdownDrainTimeoutMs; }
        public void setShutdownDrainTimeoutMs(long value) { shutdownDrainTimeoutMs = value; }
        private String host = "";
        public String getHost() { return host; }
        public void setHost(String value) { host = value; }
        private int port = 0;
        public int getPort() { return port; }
        public void setPort(int value) { port = value; }

        public void validate() {
            if (bufferSize < 1 || bufferMaxBytes < eventMaxBytes || eventMaxBytes < 1024
                    || batchSize < 1 || batchSize > 1000 || batchMaxBytes < eventMaxBytes
                    || batchMaxBytes > 1024 * 1024 || redisMaxEntries < 1
                    || flushIntervalMs < 1 || flushIntervalMs > 1000
                    || commandTimeoutMs < 1 || commandTimeoutMs > 10000
                    || retryMaxElapsedMs < commandTimeoutMs || retryMaxElapsedMs > 60000
                    || dedupTtlSeconds <= (retryMaxElapsedMs + 2 * commandTimeoutMs) / 1000 + 1
                    || shutdownDrainTimeoutMs < 1 || shutdownDrainTimeoutMs > 30000
                    || redisKey == null || redisKey.isBlank() || port < 0 || port > 65535) {
                throw new IllegalArgumentException("Invalid zenith.audit capacity, batching or retry/dedup configuration");
            }
        }

        private boolean enabled = true;
        public boolean isEnabled() { return enabled; }
        public void setEnabled(boolean enabled) { this.enabled = enabled; }

        private int bufferSize = 20000;
        private String redisKey = "zg:audit:events";
        private int redisMaxEntries = 5000;

        public int getBufferSize() {
            return bufferSize;
        }

        public void setBufferSize(int bufferSize) {
            this.bufferSize = bufferSize;
        }

        public String getRedisKey() {
            return redisKey;
        }

        public void setRedisKey(String redisKey) {
            this.redisKey = redisKey;
        }

        public int getRedisMaxEntries() {
            return redisMaxEntries;
        }

        public void setRedisMaxEntries(int redisMaxEntries) {
            this.redisMaxEntries = redisMaxEntries;
        }
    }

    public static class Route {
        private String redisKey = "zg:routes";

        public String getRedisKey() {
            return redisKey;
        }

        public void setRedisKey(String redisKey) {
            this.redisKey = redisKey;
        }
    }
}
