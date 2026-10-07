package com.zch.config;

/**
 * 监控配置不可变快照 —— 保证跨线程 happens-before 可见性。
 */
public record MonitorConfig(
        int windowSeconds,
        int emitIntervalSeconds) {

    public static MonitorConfig defaults() {
        return new MonitorConfig(10, 1);
    }

    public MonitorConfig withWindowSeconds(int windowSeconds) {
        return new MonitorConfig(sanitize(windowSeconds, 1, 120), emitIntervalSeconds);
    }

    public MonitorConfig withEmitIntervalSeconds(int emitIntervalSeconds) {
        return new MonitorConfig(windowSeconds, sanitize(emitIntervalSeconds, 1, 5));
    }

    private static int sanitize(int value, int min, int max) {
        return Math.max(min, Math.min(max, value));
    }
}
