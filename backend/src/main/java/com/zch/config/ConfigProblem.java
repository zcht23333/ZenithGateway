package com.zch.config;

import java.util.LinkedHashMap;
import java.util.Map;

/** A protocol error distinguishes rejection from absence of a trustworthy acknowledgement. */
public final class ConfigProblem extends RuntimeException {
    private final int status;
    private final String code;
    private final String outcome;
    private final Map<String, Object> details = new LinkedHashMap<>();

    public ConfigProblem(int status, String code, String outcome, String message) {
        super(message);
        this.status = status;
        this.code = code;
        this.outcome = outcome;
    }

    public static ConfigProblem validation(String field, String message) {
        return new ConfigProblem(400, "CONFIG_INVALID_REQUEST", "not-written", message).detail("field", field);
    }

    public ConfigProblem detail(String key, Object value) { details.put(key, value); return this; }
    public int status() { return status; }
    public Map<String, Object> response() {
        Map<String, Object> body = new LinkedHashMap<>(details);
        body.put("code", code);
        body.put("outcome", outcome);
        body.put("message", getMessage());
        return body;
    }
}
