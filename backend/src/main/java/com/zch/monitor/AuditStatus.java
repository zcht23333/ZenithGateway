package com.zch.monitor;

import java.util.Map;

public record AuditStatus(boolean enabled, boolean accepting, long received, long persisted,
                          long dropped, Map<String, Long> droppedByReason, long uncertain,
                          int queueDepth, int inFlight, int pending, long reservedBytes,
                          long oldestAgeMs, long retries, int lastBatchSize, long lastBatchDurationMs,
                          Long lastSuccessAgeMs, int capacity, long maxReservedBytes) { }
