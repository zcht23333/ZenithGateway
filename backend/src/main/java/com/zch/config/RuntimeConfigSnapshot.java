package com.zch.config;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.regex.Pattern;

/** One immutable value, including its storage identity. Null version exists only during startup binding. */
public record RuntimeConfigSnapshot(String version, RateLimitConfig rateLimit, MonitorConfig monitor) {
    public static final long MAX_REVISION = 9_007_199_254_740_991L;
    private static final Pattern VERSION = Pattern.compile(
            "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[1-9][0-9]{0,15}");

    public RuntimeConfigSnapshot {
        Objects.requireNonNull(rateLimit);
        Objects.requireNonNull(monitor);
        if (version != null) revision(version);
    }

    public static long revision(String version) {
        if (version == null || !VERSION.matcher(version).matches())
            throw new IllegalArgumentException("Invalid configuration version");
        long revision = Long.parseLong(version.substring(37));
        if (revision > MAX_REVISION) throw new IllegalArgumentException("Configuration revision exceeds limit");
        return revision;
    }

    public String epoch() { return version == null ? null : version.substring(0, 36); }
    public long revision() { return version == null ? 0 : revision(version); }

    public Map<String, Object> values() {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("rateLimitEnabled", rateLimit.enabled());
        map.put("replenishRate", rateLimit.replenishRate());
        map.put("burstCapacity", rateLimit.burstCapacity());
        map.put("requestedTokens", rateLimit.requestedTokens());
        map.put("monitorWindowSeconds", monitor.windowSeconds());
        map.put("emitIntervalSeconds", monitor.emitIntervalSeconds());
        return map;
    }

    public Map<String, Object> response() {
        Map<String, Object> map = values();
        map.put("version", version);
        return map;
    }

    public static RuntimeConfigSnapshot from(Map<?, ?> map, String version) {
        if (!(map.get("rateLimitEnabled") instanceof Boolean enabled))
            throw ConfigProblem.validation("rateLimitEnabled", "全局限流必须是布尔值");
        return new RuntimeConfigSnapshot(version, new RateLimitConfig(enabled,
                integer(map, "replenishRate", 10000), integer(map, "burstCapacity", 10000),
                integer(map, "requestedTokens", 100)),
                new MonitorConfig(integer(map, "monitorWindowSeconds", 120), integer(map, "emitIntervalSeconds", 5)));
    }

    private static int integer(Map<?, ?> map, String key, int max) {
        Object value = map.get(key);
        if (!(value instanceof Number n) || !Double.isFinite(n.doubleValue())
                || n.doubleValue() != Math.rint(n.doubleValue()) || n.doubleValue() < 1 || n.doubleValue() > max)
            throw ConfigProblem.validation(key, key + " 必须是 1–" + max + " 的整数");
        return n.intValue();
    }
}
