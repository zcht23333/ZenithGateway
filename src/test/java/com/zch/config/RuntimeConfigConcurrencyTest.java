package com.zch.config;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

/**
 * 验证运行时配置的跨线程 happens-before 可见性。
 *
 * 步骤② 的核心保证：Controller 写入的配置，Filter 热点路径必须立即看到。
 */
class RuntimeConfigConcurrencyTest {

    /**
     * 写线程修改配置后，读线程必须在有限时间内感知到变更。
     * 如果 AtomicReference 缺失，读线程可能永远"卡"在旧值。
     */
    @Test
    void shouldPropagateWriteToReaderThreads() throws Exception {
        GatewayRuntimeProperties properties = new GatewayRuntimeProperties();

        RateLimitConfig initial = properties.getRateLimit();
        Assertions.assertTrue(initial.enabled(), "default enabled");

        AtomicBoolean observed = new AtomicBoolean(false);
        CountDownLatch writerDone = new CountDownLatch(1);

        // 读线程：轮询直到看到 disabled 或超时
        Thread reader = new Thread(() -> {
            while (!observed.get()) {
                RateLimitConfig current = properties.getRateLimit();
                if (!current.enabled()) {
                    observed.set(true);
                    break;
                }
                Thread.yield();
            }
        });

        reader.start();

        // 写线程：关掉限流
        new Thread(() -> {
            RateLimitConfig next = properties.getRateLimit().withEnabled(false);
            properties.updateRateLimit(next);
            writerDone.countDown();
        }).start();

        writerDone.await(2, TimeUnit.SECONDS);
        reader.join(5000);

        Assertions.assertTrue(observed.get(),
                "Reader thread MUST see the updated config (AtomicReference volatile write → volatile read)");

        Assertions.assertFalse(properties.getRateLimit().enabled(),
                "Main thread must also see the update");
    }

    /**
     * 多字段原子更新：不能出现新旧混合值。
     */
    @Test
    void shouldUpdateMultipleFieldsAtomically() {
        GatewayRuntimeProperties properties = new GatewayRuntimeProperties();

        RateLimitConfig next = new RateLimitConfig(false, 500, 1000, 3);
        properties.updateRateLimit(next);

        RateLimitConfig current = properties.getRateLimit();
        Assertions.assertEquals(false, current.enabled());
        Assertions.assertEquals(500, current.replenishRate());
        Assertions.assertEquals(1000, current.burstCapacity());
        Assertions.assertEquals(3, current.requestedTokens());
    }
}
