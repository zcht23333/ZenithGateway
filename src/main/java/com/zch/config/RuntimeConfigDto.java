package com.zch.config;

public class RuntimeConfigDto {

    private boolean rateLimitEnabled;
    private int replenishRate;
    private int burstCapacity;
    private int requestedTokens;
    private int monitorWindowSeconds;
    private int emitIntervalSeconds;

    public static RuntimeConfigDto from(GatewayRuntimeProperties properties) {
        RuntimeConfigDto dto = new RuntimeConfigDto();
        dto.setRateLimitEnabled(properties.getRateLimit().isEnabled());
        dto.setReplenishRate(properties.getRateLimit().getReplenishRate());
        dto.setBurstCapacity(properties.getRateLimit().getBurstCapacity());
        dto.setRequestedTokens(properties.getRateLimit().getRequestedTokens());
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

