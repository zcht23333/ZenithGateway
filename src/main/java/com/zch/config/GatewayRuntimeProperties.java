package com.zch.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "zenith")
public class GatewayRuntimeProperties {

    private final RateLimit rateLimit = new RateLimit();
    private final Audit audit = new Audit();
    private final Monitor monitor = new Monitor();

    public RateLimit getRateLimit() {
        return rateLimit;
    }

    public Audit getAudit() {
        return audit;
    }

    public Monitor getMonitor() {
        return monitor;
    }

    public static class RateLimit {
        private boolean enabled = true;
        private int requestsPerWindow = 20;
        private int windowSeconds = 1;

        public boolean isEnabled() {
            return enabled;
        }

        public void setEnabled(boolean enabled) {
            this.enabled = enabled;
        }

        public int getRequestsPerWindow() {
            return requestsPerWindow;
        }

        public void setRequestsPerWindow(int requestsPerWindow) {
            this.requestsPerWindow = requestsPerWindow;
        }

        public int getWindowSeconds() {
            return windowSeconds;
        }

        public void setWindowSeconds(int windowSeconds) {
            this.windowSeconds = windowSeconds;
        }
    }

    public static class Audit {
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

    public static class Monitor {
        private int windowSeconds = 10;
        private int emitIntervalSeconds = 1;

        public int getWindowSeconds() {
            return windowSeconds;
        }

        public void setWindowSeconds(int windowSeconds) {
            this.windowSeconds = windowSeconds;
        }

        public int getEmitIntervalSeconds() {
            return emitIntervalSeconds;
        }

        public void setEmitIntervalSeconds(int emitIntervalSeconds) {
            this.emitIntervalSeconds = emitIntervalSeconds;
        }
    }
}

