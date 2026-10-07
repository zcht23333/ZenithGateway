package com.zch.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/** Process-level sync settings, separate from the six versioned runtime fields. */
@ConfigurationProperties("zenith.runtime.sync")
public class RuntimeConfigSyncProperties {
    private final String instanceId = java.util.UUID.randomUUID().toString();
    public String getInstanceId() { return instanceId; }
    private boolean enabled = true;
    private long intervalMs = 2000;
    private long timeoutMs = 1000;
    private long staleAfterMs = 10000;

    public boolean isEnabled() { return enabled; }
    public void setEnabled(boolean value) { enabled = value; }
    public long getIntervalMs() { return intervalMs; }
    public void setIntervalMs(long value) { intervalMs = value; }
    public long getTimeoutMs() { return timeoutMs; }
    public void setTimeoutMs(long value) { timeoutMs = value; }
    public long getStaleAfterMs() { return staleAfterMs; }
    public void setStaleAfterMs(long value) { staleAfterMs = value; }

    public void validate() {
        if (intervalMs < 100 || intervalMs > 60000 || timeoutMs < 100 || timeoutMs > 10000
                || staleAfterMs < intervalMs + timeoutMs || staleAfterMs > 600000)
            throw new IllegalArgumentException("Invalid runtime sync interval (100..60000 ms), timeout (100..10000 ms), or freshness budget");
    }
}
