package com.zch.config;

public class RuntimeConfigDto {

    private boolean rateLimitEnabled;
    private int requestsPerWindow;
    private int rateLimitWindowSeconds;
    private int monitorWindowSeconds;
    private int emitIntervalSeconds;

    public static RuntimeConfigDto from(GatewayRuntimeProperties properties) {
        RuntimeConfigDto dto = new RuntimeConfigDto();
        dto.setRateLimitEnabled(properties.getRateLimit().isEnabled());
        dto.setRequestsPerWindow(properties.getRateLimit().getRequestsPerWindow());
        dto.setRateLimitWindowSeconds(properties.getRateLimit().getWindowSeconds());
        dto.setMonitorWindowSeconds(properties.getMonitor().getWindowSeconds());
        dto.setEmitIntervalSeconds(properties.getMonitor().getEmitIntervalSeconds());
        return dto;
    }

    public boolean isRateLimitEnabled() {
        return rateLimitEnabled;
    }

    public void setRateLimitEnabled(boolean rateLimitEnabled) {
        this.rateLimitEnabled = rateLimitEnabled;
    }

    public int getRequestsPerWindow() {
        return requestsPerWindow;
    }

    public void setRequestsPerWindow(int requestsPerWindow) {
        this.requestsPerWindow = requestsPerWindow;
    }

    public int getRateLimitWindowSeconds() {
        return rateLimitWindowSeconds;
    }

    public void setRateLimitWindowSeconds(int rateLimitWindowSeconds) {
        this.rateLimitWindowSeconds = rateLimitWindowSeconds;
    }

    public int getMonitorWindowSeconds() {
        return monitorWindowSeconds;
    }

    public void setMonitorWindowSeconds(int monitorWindowSeconds) {
        this.monitorWindowSeconds = monitorWindowSeconds;
    }

    public int getEmitIntervalSeconds() {
        return emitIntervalSeconds;
    }

    public void setEmitIntervalSeconds(int emitIntervalSeconds) {
        this.emitIntervalSeconds = emitIntervalSeconds;
    }
}

