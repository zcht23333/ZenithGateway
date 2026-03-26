package com.zch.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "zenith")
public class GatewayRuntimeProperties {

    private final RateLimit rateLimit = new RateLimit();
    private final Audit audit = new Audit();
    private final Monitor monitor = new Monitor();
    private final Route route = new Route();

    public RateLimit getRateLimit() {
        return rateLimit;
    }

    public Audit getAudit() {
        return audit;
    }

    public Monitor getMonitor() {
        return monitor;
    }

    public Route getRoute() {
        return route;
    }

    public static class RateLimit {
        private boolean enabled = true;
        private int replenishRate = 20;
        private int burstCapacity = 20;
        private int requestedTokens = 1;

        public boolean isEnabled() {
            return enabled;
        }

        public void setEnabled(boolean enabled) {
            this.enabled = enabled;
        }

        public int getReplenishRate() {
            return replenishRate;
        }

        public void setReplenishRate(int replenishRate) {
            this.replenishRate = replenishRate;
        }

        public int getBurstCapacity() {
            return burstCapacity;
        }

        public void setBurstCapacity(int burstCapacity) {
            this.burstCapacity = burstCapacity;
        }

        public int getRequestedTokens() {
            return requestedTokens;
        }

        public void setRequestedTokens(int requestedTokens) {
            this.requestedTokens = requestedTokens;
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

