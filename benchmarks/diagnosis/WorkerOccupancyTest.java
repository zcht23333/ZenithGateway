package com.zch.ratelimit;

import com.zch.config.*;
import io.lettuce.core.*;
import io.lettuce.core.api.*;
import io.lettuce.core.api.async.*;
import java.lang.reflect.Field;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.*;
import org.junit.jupiter.api.Test;
import org.springframework.boot.data.redis.autoconfigure.DataRedisProperties;
import tools.jackson.databind.json.JsonMapper;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/** Deterministic causal fixture: Redis has completed, only the result consumer is held. */
class WorkerOccupancyTest {
    @SuppressWarnings("unchecked")
    @Test void downstreamHoldsPhysicalWorkerAfterDecisionPermitIsReleased() throws Exception {
        var policy=new LimiterProperties();policy.setWorkers(1);policy.setQueueCapacity(1);policy.setDecisionTimeoutMs(2000);
        var limiter=new RedisRateLimiter(new DataRedisProperties(),policy,new RuntimeConfigSyncProperties(),JsonMapper.builder().build());
        var connection=(StatefulRedisConnection<String,String>)mock(StatefulRedisConnection.class);
        var commands=(RedisAsyncCommands<String,String>)mock(RedisAsyncCommands.class);
        var reply=(RedisFuture<String>)mock(RedisFuture.class);
        when(connection.isOpen()).thenReturn(true);when(connection.async()).thenReturn(commands);
        when(commands.<String>eval(anyString(),eq(ScriptOutputType.VALUE),any(String[].class),any(String[].class))).thenReturn(reply);
        when(reply.get(anyLong(),eq(TimeUnit.NANOSECONDS))).thenReturn("{\"outcome\":\"allowed\",\"reason\":\"quota_available\",\"execution\":\"confirmed\",\"staleRequest\":false}");
        var workers=(ThreadPoolExecutor)field(RedisRateLimiter.class,"workers").get(limiter);
        var local=(ThreadLocal<?>)field(RedisRateLimiter.class,"local").get(limiter);
        workers.submit(()->{var slot=local.get();field(slot.getClass(),"connection").set(slot,connection);return null;}).get(2,TimeUnit.SECONDS);
        var snapshot=new RuntimeConfigSnapshot("11111111-1111-1111-1111-111111111111:1",new RateLimitConfig(true,10000,10000,1),MonitorConfig.defaults());
        var insideConsumer=new CountDownLatch(1);var releaseConsumer=new CountDownLatch(1);var firstDone=new CountDownLatch(1);
        try {
            limiter.decide(snapshot,"test").subscribe(d->{
                assertEquals("allowed",d.outcome());insideConsumer.countDown();
                try{assertTrue(releaseConsumer.await(5,TimeUnit.SECONDS));}catch(InterruptedException e){Thread.currentThread().interrupt();fail(e);}
                firstDone.countDown();
            });
            assertTrue(insideConsumer.await(2,TimeUnit.SECONDS));
            var held=limiter.status();
            assertEquals(2,held.get("availableDecisionPermits"),"The quota decision has released admission.");
            assertEquals(1,held.get("activeWorkers"),"The same physical worker is still in the subscriber.");
            assertEquals(1,held.get("commandsInFlight"),"This gauge includes downstream work even after Redis returned.");
            var queued=limiter.decide(snapshot,"test").toFuture();
            assertEquals(1,limiter.status().get("queued"));
            var rejected=limiter.decide(snapshot,"test").block(Duration.ofSeconds(1));
            assertEquals("local_fail_open",rejected.outcome());assertEquals("queue_full",rejected.reason());
            verify(reply,times(1)).get(anyLong(),eq(TimeUnit.NANOSECONDS));
            releaseConsumer.countDown();
            assertTrue(firstDone.await(2,TimeUnit.SECONDS));
            assertEquals("allowed",queued.get(2,TimeUnit.SECONDS).outcome());
            workers.submit(()->{}).get(2,TimeUnit.SECONDS);
            var drained=limiter.status();
            assertEquals(0,drained.get("commandsInFlight"));
            assertEquals(0,drained.get("queued"));
            assertEquals(2,drained.get("availableDecisionPermits"));
            System.out.println("CAUSAL_FIXTURE: completed Redis reply + blocked downstream -> physical worker held -> next queue overflows; release downstream -> queued decision completes.");
        } finally {releaseConsumer.countDown();limiter.destroy();}
    }
    private static Field field(Class<?> owner,String name) throws Exception{var f=owner.getDeclaredField(name);f.setAccessible(true);return f;}
}
