package com.zch.config;

import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/settings")
public class RuntimeConfigController {

    private final GatewayRuntimeProperties runtimeProperties;

    public RuntimeConfigController(GatewayRuntimeProperties runtimeProperties) {
        this.runtimeProperties = runtimeProperties;
    }

    @GetMapping("/runtime")
    public Map<String, Object> current() {
        return toResponse();
    }

    @PutMapping("/runtime")
    public Map<String, Object> update(@RequestBody Map<String, Object> request) {
        GatewayRuntimeProperties.RateLimit rateLimit = runtimeProperties.getRateLimit();
        GatewayRuntimeProperties.Monitor monitor = runtimeProperties.getMonitor();

        synchronized (runtimeProperties) {
            rateLimit.setEnabled(readBoolean(request, "rateLimitEnabled", rateLimit.isEnabled()));
            rateLimit.setReplenishRate(clamp(readInt(request, "replenishRate", rateLimit.getReplenishRate()), 1, 10000));
            rateLimit.setBurstCapacity(clamp(readInt(request, "burstCapacity", rateLimit.getBurstCapacity()), 1, 10000));
            rateLimit.setRequestedTokens(clamp(readInt(request, "requestedTokens", rateLimit.getRequestedTokens()), 1, 100));

            monitor.setWindowSeconds(clamp(readInt(request, "monitorWindowSeconds", monitor.getWindowSeconds()), 1, 120));
            monitor.setEmitIntervalSeconds(clamp(readInt(request, "emitIntervalSeconds", monitor.getEmitIntervalSeconds()), 1, 5));
        }

        return toResponse();
    }

    private int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(max, value));
    }

    private int readInt(Map<String, Object> request, String key, int defaultValue) {
        Object raw = request.get(key);
        if (raw == null) {
            return defaultValue;
        }
        if (raw instanceof Number number) {
            return number.intValue();
        }
        try {
            return Integer.parseInt(String.valueOf(raw));
        } catch (NumberFormatException ignore) {
            return defaultValue;
        }
    }

    private boolean readBoolean(Map<String, Object> request, String key, boolean defaultValue) {
        Object raw = request.get(key);
        if (raw == null) {
            return defaultValue;
        }
        if (raw instanceof Boolean b) {
            return b;
        }
        return Boolean.parseBoolean(String.valueOf(raw));
    }

    private Map<String, Object> toResponse() {
        GatewayRuntimeProperties.RateLimit rateLimit = runtimeProperties.getRateLimit();
        GatewayRuntimeProperties.Monitor monitor = runtimeProperties.getMonitor();

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("rateLimitEnabled", rateLimit.isEnabled());
        payload.put("replenishRate", rateLimit.getReplenishRate());
        payload.put("burstCapacity", rateLimit.getBurstCapacity());
        payload.put("requestedTokens", rateLimit.getRequestedTokens());
        payload.put("monitorWindowSeconds", monitor.getWindowSeconds());
        payload.put("emitIntervalSeconds", monitor.getEmitIntervalSeconds());
        return payload;
    }
}

