package com.zch.monitor;

import java.time.Duration;
import java.util.List;

public interface AuditBatchWriter extends AutoCloseable {
    /** Returns only after Redis acknowledgement (including acknowledgement of a duplicate batch). */
    void write(String batchId, List<String> payloads, Duration timeout) throws Exception;
    @Override
    default void close() { }
}
