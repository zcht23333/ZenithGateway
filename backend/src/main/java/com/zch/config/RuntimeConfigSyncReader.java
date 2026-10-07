package com.zch.config;

import java.time.Duration;

/** Only called by the dedicated sync worker. Implementations must bound I/O by the supplied budget. */
public interface RuntimeConfigSyncReader extends AutoCloseable {
    RuntimeConfigSnapshot read(Duration budget) throws Exception;
    @Override void close();
}
