package com.zch.config;

/**
 * 限流配置不可变快照 —— 保证跨线程 happens-before 可见性。
 */
public record RateLimitConfig(
        boolean enabled,
        int replenishRate,
        int burstCapacity,
        int requestedTokens) {

    public static RateLimitConfig defaults() {
        return new RateLimitConfig(true, 20, 20, 1);
    }

    public RateLimitConfig withEnabled(boolean enabled) {
        return new RateLimitConfig(enabled, replenishRate, burstCapacity, requestedTokens);
    }

    public RateLimitConfig withReplenishRate(int replenishRate) {
        return new RateLimitConfig(enabled, replenishRate, burstCapacity, requestedTokens);
    }

    public RateLimitConfig withBurstCapacity(int burstCapacity) {
        return new RateLimitConfig(enabled, replenishRate, burstCapacity, requestedTokens);
    }

    public RateLimitConfig withRequestedTokens(int requestedTokens) {
        return new RateLimitConfig(enabled, replenishRate, burstCapacity, requestedTokens);
    }
}
