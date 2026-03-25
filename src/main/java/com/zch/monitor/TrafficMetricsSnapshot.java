package com.zch.monitor;

public class TrafficMetricsSnapshot {

    private long timestamp;
    private int windowSeconds;
    private long requestCount;
    private double qps;
    private double avgLatencyMs;
    private long p95LatencyMs;
    private long status2xx;
    private long status4xx;
    private long status5xx;

    public long getTimestamp() {
        return timestamp;
    }

    public void setTimestamp(long timestamp) {
        this.timestamp = timestamp;
    }

    public int getWindowSeconds() {
        return windowSeconds;
    }

    public void setWindowSeconds(int windowSeconds) {
        this.windowSeconds = windowSeconds;
    }

    public long getRequestCount() {
        return requestCount;
    }

    public void setRequestCount(long requestCount) {
        this.requestCount = requestCount;
    }

    public double getQps() {
        return qps;
    }

    public void setQps(double qps) {
        this.qps = qps;
    }

    public double getAvgLatencyMs() {
        return avgLatencyMs;
    }

    public void setAvgLatencyMs(double avgLatencyMs) {
        this.avgLatencyMs = avgLatencyMs;
    }

    public long getP95LatencyMs() {
        return p95LatencyMs;
    }

    public void setP95LatencyMs(long p95LatencyMs) {
        this.p95LatencyMs = p95LatencyMs;
    }

    public long getStatus2xx() {
        return status2xx;
    }

    public void setStatus2xx(long status2xx) {
        this.status2xx = status2xx;
    }

    public long getStatus4xx() {
        return status4xx;
    }

    public void setStatus4xx(long status4xx) {
        this.status4xx = status4xx;
    }

    public long getStatus5xx() {
        return status5xx;
    }

    public void setStatus5xx(long status5xx) {
        this.status5xx = status5xx;
    }
}

