package com.zch.ratelimit;

import com.zch.config.*;
import io.lettuce.core.*;
import io.lettuce.core.api.*;
import io.lettuce.core.api.async.*;
import java.lang.reflect.Field;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BiConsumer;
import org.junit.jupiter.api.Test;
import org.springframework.boot.data.redis.autoconfigure.DataRedisProperties;
import tools.jackson.databind.json.JsonMapper;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class RedisRateLimiterHandoffTest {
    static final RuntimeConfigSnapshot SNAPSHOT=new RuntimeConfigSnapshot("11111111-1111-4111-8111-111111111111:1",new RateLimitConfig(true,10000,10000,1),MonitorConfig.defaults());
    static final String ALLOWED="{\"outcome\":\"allowed\",\"reason\":\"quota_available\",\"execution\":\"confirmed\",\"staleRequest\":false}";
    static Field field(Class<?> owner,String name)throws Exception{var f=owner.getDeclaredField(name);f.setAccessible(true);return f;}
    @SuppressWarnings("unchecked")
    static final class Fixture implements AutoCloseable {
        final RedisRateLimiter limiter;
        final StatefulRedisConnection<String,String> connection=mock(StatefulRedisConnection.class);
        final RedisAsyncCommands<String,String> commands=mock(RedisAsyncCommands.class);
        final RedisFuture<String> reply=mock(RedisFuture.class);
        final CompletableFuture<String> received=new CompletableFuture<>();
        final ThreadPoolExecutor workers,deliveries;
        Fixture(boolean handoff)throws Exception{this(handoff,false);}
        Fixture(boolean handoff,boolean strict)throws Exception{
            var p=new LimiterProperties();p.setWorkers(1);p.setQueueCapacity(1);p.setResultWorkers(1);p.setResultHandoffEnabled(handoff);p.setSaturationSamplingEnabled(true);p.setDecisionTimeoutMs(2000);
            if(strict){p.setLocalFailurePolicy(LimiterProperties.FailurePolicy.REJECT);p.setRedisFailurePolicy(LimiterProperties.FailurePolicy.REJECT);}
            limiter=new RedisRateLimiter(new DataRedisProperties(),p,new RuntimeConfigSyncProperties(),JsonMapper.builder().build());
            when(connection.isOpen()).thenReturn(true);when(connection.async()).thenReturn(commands);when(connection.closeAsync()).thenReturn(CompletableFuture.completedFuture(null));
            when(commands.<String>eval(anyString(),eq(ScriptOutputType.VALUE),any(String[].class),any(String[].class))).thenReturn(reply);
            when(reply.whenComplete(any())).thenAnswer(i->received.whenComplete((BiConsumer<String,Throwable>)i.getArgument(0)));
            when(reply.get(anyLong(),eq(TimeUnit.NANOSECONDS))).thenAnswer(i->received.get(i.getArgument(0),TimeUnit.NANOSECONDS));
            workers=(ThreadPoolExecutor)field(RedisRateLimiter.class,"workers").get(limiter);
            deliveries=(ThreadPoolExecutor)field(RedisRateLimiter.class,"deliveries").get(limiter);
            var local=(ThreadLocal<?>)field(RedisRateLimiter.class,"local").get(limiter);
            workers.submit(()->{var s=local.get();field(s.getClass(),"connection").set(s,connection);return null;}).get(2,TimeUnit.SECONDS);
        }
        void drain()throws Exception{
            until(()->workers.getActiveCount()==0&&workers.getQueue().isEmpty());
            workers.submit(()->{}).get(2,TimeUnit.SECONDS);
            if(deliveries!=null){until(()->deliveries.getActiveCount()==0&&deliveries.getQueue().isEmpty());deliveries.submit(()->{}).get(2,TimeUnit.SECONDS);}
        }
        @Override public void close(){limiter.destroy();}
    }
    static void waitGate(CountDownLatch gate){try{gate.await(10,TimeUnit.SECONDS);}catch(InterruptedException e){Thread.currentThread().interrupt();}}
    static Map<?,?> observations(RedisRateLimiter limiter){return (Map<?,?>)limiter.status().get("observations");}
    static void until(java.util.function.BooleanSupplier condition)throws Exception{
        long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(3);
        while(!condition.getAsBoolean()){if(System.nanoTime()>end)fail("Condition did not become true");Thread.onSpinWait();}
    }

    @Test void inlineBaselineSeparatesCompletedRedisFromBlockedDownstream()throws Exception{
        try(var f=new Fixture(false)){
            f.received.complete(ALLOWED);var inside=new CountDownLatch(1);var release=new CountDownLatch(1);
            try{
                f.limiter.decide(SNAPSHOT,"client").subscribe(d->{inside.countDown();waitGate(release);});
                assertTrue(inside.await(2,TimeUnit.SECONDS));var state=f.limiter.status();
                assertEquals(0,state.get("commandsInFlight"));assertEquals(1,state.get("activeWorkers"));
                assertEquals(0,state.get("activeDeliveries"));assertEquals(1,state.get("activeInlineDeliveries"));assertEquals(2,state.get("availableDecisionPermits"));
                assertEquals(1L,observations(f.limiter).get("commandResultsObserved"));
            }finally{release.countDown();f.drain();}
        }
    }
    @Test void observedFutureCompletionDoesNotWaitForGetToResume()throws Exception{
        try(var f=new Fixture(true)){
            var waiting=new CountDownLatch(1);var resume=new CountDownLatch(1);
            when(f.reply.get(anyLong(),eq(TimeUnit.NANOSECONDS))).thenAnswer(i->{waiting.countDown();waitGate(resume);return f.received.get();});
            var result=f.limiter.decide(SNAPSHOT,"client").toFuture();
            try{
                assertTrue(waiting.await(2,TimeUnit.SECONDS));assertEquals(1,f.limiter.status().get("commandsInFlight"));
                f.received.complete(ALLOWED);
                assertEquals(0,f.limiter.status().get("commandsInFlight"));assertEquals(1,f.limiter.status().get("activeWorkers"));
                assertFalse(result.isDone());
            }finally{resume.countDown();}
            assertEquals("allowed",result.get(2,TimeUnit.SECONDS).outcome());f.drain();
        }
    }
    @Test void blockedResultConsumerDoesNotHoldIoAndSharedReservationsBoundEveryStage()throws Exception{
        try(var f=new Fixture(true)){
            f.received.complete(ALLOWED);var inside=new CountDownLatch(1);var release=new CountDownLatch(1);
            var thread=new AtomicReference<String>();
            try{
                f.limiter.decide(SNAPSHOT,"one").subscribe(d->{thread.set(Thread.currentThread().getName());inside.countDown();waitGate(release);});
                assertTrue(inside.await(2,TimeUnit.SECONDS));f.workers.submit(()->{}).get(2,TimeUnit.SECONDS);
                var second=f.limiter.decide(SNAPSHOT,"two").toFuture();
                until(()->((Number)f.limiter.status().get("queuedDeliveries")).intValue()==1);
                f.workers.submit(()->{}).get(2,TimeUnit.SECONDS);
                until(()->f.workers.getActiveCount()==0);var held=f.limiter.status();assertTrue(thread.get().startsWith("rate-limit-result-"));
                assertEquals(0,held.get("commandsInFlight"));assertEquals(0,held.get("activeWorkers"));
                assertEquals(1,held.get("activeDeliveries"));assertEquals(0,held.get("availableDecisionPermits"));assertEquals(2,held.get("retainedTasks"));
                var rejected=f.limiter.decide(SNAPSHOT,"three").block(Duration.ofSeconds(1));
                assertEquals("queue_full",rejected.reason());
                var events=f.limiter.saturationStatus(0);
                var sample=(LimiterSaturationSamples.Sample)((java.util.List<?>)events.get("samples")).getFirst();
                assertEquals("admission_full",sample.reason());assertEquals(2,sample.state().get("retainedTasks"));
                assertEquals(0,sample.state().get("commandsInFlight"));assertEquals(1,sample.state().get("activeDeliveries"));
                assertEquals(1,sample.state().get("resultQueued"));
                verify(f.commands,times(2)).eval(anyString(),eq(ScriptOutputType.VALUE),any(String[].class),any(String[].class));
                assertTrue(second.cancel(false));until(()->((Number)f.limiter.status().get("queuedDeliveries")).intValue()==0);
                assertEquals(1,f.limiter.status().get("availableDecisionPermits"));
                var fourth=f.limiter.decide(SNAPSHOT,"four").toFuture();
                release.countDown();assertEquals("allowed",fourth.get(2,TimeUnit.SECONDS).outcome());f.drain();
                assertEquals(2,f.limiter.status().get("availableDecisionPermits"));assertEquals(0,f.limiter.status().get("retainedTasks"));
                var o=observations(f.limiter);assertEquals(1L,((Map<?,?>)o.get("reasons")).get("queue_full"));
                assertEquals(1L,((Map<?,?>)o.get("rejections")).get("admission_full"));assertEquals(0L,((Map<?,?>)o.get("rejections")).get("delivery_rejected"));
                assertEquals(1L,o.get("postDecisionCancellations"));
            }finally{release.countDown();}
        }
    }
    @Test void physicalOwnershipSurvivesCancellationUntilWorkerCleanup()throws Exception{
        try(var f=new Fixture(true)){
            var entered=new CountDownLatch(1);var release=new CountDownLatch(1);
            when(f.reply.get(anyLong(),eq(TimeUnit.NANOSECONDS))).thenAnswer(i->{entered.countDown();return f.received.get(2,TimeUnit.SECONDS);});
            var closed=new CompletableFuture<Void>();
            when(f.connection.closeAsync()).thenReturn(closed);
            var result=f.limiter.decide(SNAPSHOT,"client").toFuture();
            try{
                assertTrue(entered.await(2,TimeUnit.SECONDS));result.cancel(true);
                until(()->((Number)f.limiter.status().get("closing")).intValue()==1);
                assertEquals(1,f.limiter.status().get("commandsInFlight"));
                assertEquals(1,f.limiter.status().get("availableDecisionPermits"));
                closed.complete(null);f.drain();assertEquals(0,f.limiter.status().get("commandsInFlight"));
                assertEquals(2,f.limiter.status().get("availableDecisionPermits"));
                assertEquals(1L,observations(f.limiter).get("commandsAbandonedAfterClose"));
            }finally{closed.complete(null);release.countDown();}
        }
    }
    @Test void executorRejectionIsCountedSeparatelyAndDoesNotLeakAReservation()throws Exception{
        try(var f=new Fixture(true)){
            var entered=new CountDownLatch(1);var release=new CountDownLatch(1);
            try{
                f.workers.submit(()->{entered.countDown();waitGate(release);});
                assertTrue(entered.await(2,TimeUnit.SECONDS));f.workers.execute(()->{});
                var result=f.limiter.decide(SNAPSHOT,"client").block(Duration.ofSeconds(1));
                assertEquals("queue_full",result.reason());f.deliveries.submit(()->{}).get(2,TimeUnit.SECONDS);
                assertEquals(2,f.limiter.status().get("availableDecisionPermits"));
                var r=(Map<?,?>)observations(f.limiter).get("rejections");
                assertEquals(0L,r.get("admission_full"));assertEquals(1L,r.get("executor_rejected"));
                verifyNoInteractions(f.commands);
            }finally{release.countDown();f.drain();}
        }
    }
    @Test void shutdownReleasesReservedDeliverySlotsAndTerminatesQueuedSubscribers()throws Exception{
        try(var f=new Fixture(true)){
            f.received.complete(ALLOWED);var entered=new CountDownLatch(1);var release=new CountDownLatch(1);
            try{
                f.limiter.decide(SNAPSHOT,"first").subscribe(d->{entered.countDown();waitGate(release);});
                assertTrue(entered.await(2,TimeUnit.SECONDS));
                var second=f.limiter.decide(SNAPSHOT,"second").toFuture();
                until(()->((Number)f.limiter.status().get("queuedDeliveries")).intValue()==1);
                f.limiter.destroy();
                assertTrue(second.isCompletedExceptionally());
                assertEquals(0,f.limiter.status().get("retainedTasks"));
                assertEquals(0,f.limiter.status().get("queuedDeliveries"));
                assertEquals(0,f.limiter.status().get("activeDeliveries"));
                assertEquals(2,f.limiter.status().get("availableDecisionPermits"));
                assertTrue(f.workers.isTerminated());assertTrue(f.deliveries.isTerminated());
            }finally{release.countDown();}
        }
    }

    @Test void anInterruptedCloserStillTerminatesQueuedDeliveryAndRestoresItsInterruptFlag()throws Exception{
        try(var f=new Fixture(true)){
            f.received.complete(ALLOWED);var entered=new CountDownLatch(1);var release=new CountDownLatch(1);
            var interrupted=new java.util.concurrent.atomic.AtomicBoolean();var failure=new AtomicReference<Throwable>();
            try{
                f.limiter.decide(SNAPSHOT,"first").subscribe(d->{entered.countDown();waitGate(release);});
                assertTrue(entered.await(2,TimeUnit.SECONDS));var second=f.limiter.decide(SNAPSHOT,"second").toFuture();
                until(()->((Number)f.limiter.status().get("queuedDeliveries")).intValue()==1);
                var closer=new Thread(()->{
                    Thread.currentThread().interrupt();
                    try{f.limiter.destroy();interrupted.set(Thread.currentThread().isInterrupted());}
                    catch(Throwable error){failure.set(error);}
                });closer.start();closer.join(5000);
                assertFalse(closer.isAlive());assertNull(failure.get());assertTrue(interrupted.get());
                assertTrue(second.isCompletedExceptionally());assertEquals(0,f.limiter.status().get("retainedTasks"));
                assertTrue(f.deliveries.isTerminated());assertEquals(2,f.limiter.status().get("availableDecisionPermits"));
            }finally{release.countDown();}
        }
    }


    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(booleans={false,true})
    void strictExecutorRejectionDoesNotDispatchOrLeakPermits(boolean handoff)throws Exception{
        try(var f=new Fixture(handoff,true)){
            var entered=new CountDownLatch(1);var release=new CountDownLatch(1);
            try{
                f.workers.submit(()->{entered.countDown();waitGate(release);});assertTrue(entered.await(2,TimeUnit.SECONDS));f.workers.execute(()->{});
                var d=f.limiter.decide(SNAPSHOT,"rejected").block(Duration.ofSeconds(1));
                assertFalse(d.forwards());assertEquals("local_rejected",d.outcome());assertEquals("executor_rejected",d.rejectionSource());assertEquals("not_sent",d.execution());
                verifyNoInteractions(f.commands);
            }finally{release.countDown();f.drain();}
            assertEquals(2,f.limiter.status().get("availableDecisionPermits"));
            assertEquals(1L,((Map<?,?>)observations(f.limiter).get("actions")).get("reject"));
            assertEquals(0L,((Map<?,?>)f.limiter.status().get("outcomes")).get("local_fail_open"));
        }
    }
    @Test void strictCancellationAfterDispatchRetainsUnknownAndDoesNotChooseRejection()throws Exception{
        try(var f=new Fixture(true,true)){
            var o=new com.zch.monitor.RequestObservation();
            var pending=f.limiter.decide(SNAPSHOT,"cancel").contextWrite(c->c.put(com.zch.monitor.RequestObservation.CONTEXT_KEY,o)).toFuture();
            until(()->((Number)f.limiter.status().get("commandsInFlight")).intValue()==1);
            assertTrue(pending.cancel(true));f.drain();
            assertEquals("cancelled",o.rateLimitEvent);assertEquals("cancel",o.rateLimitAction);assertEquals("unknown",o.rateLimitExecution);
            assertEquals(1L,((Map<?,?>)f.limiter.status().get("outcomes")).get("cancelled"));
            assertEquals(0L,((Map<?,?>)f.limiter.status().get("outcomes")).get("redis_rejected"));
            assertEquals(2,f.limiter.status().get("availableDecisionPermits"));
        }
    }
}
