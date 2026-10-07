package com.zch.config;

import java.util.Map;

/**
 * 配置绑定通用工具方法，消除 RuntimeConfigController 和 RuntimeConfigPersistence 之间的重复代码。
 */
final class ConfigUtils {

    private ConfigUtils() {
    }

    static int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(max, value));
    }

    static int readInt(Map<String, Object> map, String key, int defaultValue) {
        Object raw = map.get(key);
        if (raw == null) return defaultValue;
        if (raw instanceof Number number) return number.intValue();
        try {
            return Integer.parseInt(String.valueOf(raw));
        } catch (NumberFormatException ignore) {
            return defaultValue;
        }
    }

    static boolean readBoolean(Map<String, Object> map, String key, boolean defaultValue) {
        Object raw = map.get(key);
        if (raw == null) return defaultValue;
        if (raw instanceof Boolean b) return b;
        return Boolean.parseBoolean(String.valueOf(raw));
    }
}
