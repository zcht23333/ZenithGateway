package com.zch.config;

import java.util.Map;

/** Identity of a successful retained commit, never client-supplied configuration values. */
public record RuntimeConfigSource(String version, String operationId) {
    public RuntimeConfigSource {
        try { RuntimeConfigSnapshot.revision(version); }
        catch (IllegalArgumentException error) { throw ConfigProblem.validation("source", "来源版本格式非法"); }
        RuntimeConfigPersistence.validateOperationId(operationId);
    }
    public static RuntimeConfigSource from(Object value) {
        if (!(value instanceof Map<?, ?> source) || source.size() != 2
                || !(source.get("version") instanceof String version)
                || !(source.get("operationId") instanceof String operationId))
            throw ConfigProblem.validation("source", "恢复来源必须仅包含 version 与 operationId");
        return new RuntimeConfigSource(version, operationId);
    }
    public Map<String, Object> reference() { return Map.of("version", version, "operationId", operationId); }
    public boolean matches(Object value) {
        return value instanceof Map<?, ?> source && version.equals(source.get("version"))
                && operationId.equals(source.get("operationId"));
    }
}
