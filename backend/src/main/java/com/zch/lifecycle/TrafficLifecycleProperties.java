package com.zch.lifecycle;

import org.springframework.boot.context.properties.ConfigurationProperties;

/** Process budgets only; never part of the six-field runtime protocol. */
@ConfigurationProperties("zenith.lifecycle")
public class TrafficLifecycleProperties {
    private long requestDrainTimeoutMs = 10000;
    private long cancellationSettleTimeoutMs = 1000;
    public long getRequestDrainTimeoutMs() { return requestDrainTimeoutMs; }
    public void setRequestDrainTimeoutMs(long value) { requestDrainTimeoutMs = value; }
    public long getCancellationSettleTimeoutMs() { return cancellationSettleTimeoutMs; }
    public void setCancellationSettleTimeoutMs(long value) { cancellationSettleTimeoutMs = value; }
    public void validate() {
        if (requestDrainTimeoutMs < 100 || requestDrainTimeoutMs > 60000
                || cancellationSettleTimeoutMs < 100 || cancellationSettleTimeoutMs > 5000)
            throw new IllegalArgumentException("Invalid zenith.lifecycle request (100..60000 ms) or cancellation (100..5000 ms) budget");
    }
}
