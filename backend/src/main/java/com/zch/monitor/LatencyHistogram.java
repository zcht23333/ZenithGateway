package com.zch.monitor;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.concurrent.atomic.AtomicLongArray;

/** Millisecond upper bounds: exact through 100 ms, at most 5% rounding thereafter. */
final class LatencyHistogram {
    static final long MAX_MS = 60_000;
    static final long[] BOUNDS;
    static {
        var bounds = new ArrayList<Long>();
        for (long value = 0; value <= 100; value++) bounds.add(value);
        long value = 100;
        while (value < MAX_MS) {
            value = Math.min(MAX_MS, value + Math.max(1, value / 20));
            bounds.add(value);
        }
        BOUNDS = bounds.stream().mapToLong(Long::longValue).toArray();
    }
    final AtomicLongArray counts = new AtomicLongArray(BOUNDS.length + 1);

    void record(long value) {
        int index = Arrays.binarySearch(BOUNDS, Math.max(0, value));
        counts.incrementAndGet(index < 0 ? -index - 1 : index);
    }

    void addTo(long[] target) {
        for (int i = 0; i < target.length; i++) target[i] += counts.get(i);
    }

    static long percentile95(long[] counts) {
        long total = Arrays.stream(counts).sum();
        if (total == 0) return 0;
        long threshold = total - total / 20;
        long sum = 0;
        for (int i = 0; i < counts.length; i++) {
            sum += counts[i];
            if (sum >= threshold) return i == BOUNDS.length ? -1 : BOUNDS[i];
        }
        return 0;
    }
}
