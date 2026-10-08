package com.zch.ratelimit;

import com.zch.config.RuntimeConfigSyncProperties;
import io.lettuce.core.RedisFuture;
import java.lang.reflect.*;
import java.util.Map;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import java.util.function.BiConsumer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.boot.data.redis.autoconfigure.DataRedisProperties;
import tools.jackson.databind.json.JsonMapper;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import static com.zch.ratelimit.RedisRateLimiterHandoffTest.*;

/** The same callback barrier can run against classes extracted from the historical production JAR. */
public class RedisRateLimiterCommandTest {
    private static final class Commands implements AutoCloseable {
        final RedisRateLimiter limiter;
        final Constructor<?> constructor;
        final Method observed,closed;
        final Object task;
        final Field waiting;
        Commands(int workers)throws Exception{
            var policy=new LimiterProperties();policy.setWorkers(workers);policy.setQueueCapacity(0);
            limiter=new RedisRateLimiter(new DataRedisProperties(),policy,new RuntimeConfigSyncProperties(),JsonMapper.builder().build());
            var taskType=Class.forName("com.zch.ratelimit.RedisRateLimiter$Task");
            var taskConstructor=taskType.getDeclaredConstructors()[0];taskConstructor.setAccessible(true);
            task=taskConstructor.newInstance(limiter,null,"fixture",null,null);
            var type=Class.forName("com.zch.ratelimit.RedisRateLimiter$Command");
            constructor=type.getDeclaredConstructor(RedisRateLimiter.class,taskType);constructor.setAccessible(true);
            observed=type.getDeclaredMethod("observed");observed.setAccessible(true);
            closed=type.getDeclaredMethod("closed");closed.setAccessible(true);waiting=field(type,"waiting");
        }
        Object create()throws Exception{return constructor.newInstance(limiter,task);}
        int current(){return (Integer)limiter.status().get("commandsInFlight");}
        int peak(){return (Integer)limiter.status().get("peakCommandsInFlight");}
        long settlements(){var o=observations(limiter);return (Long)o.get("commandResultsObserved")+(Long)o.get("commandsAbandonedAfterClose");}
        @Override public void close(){limiter.destroy();}
    }
    private static void await(CountDownLatch gate)throws InterruptedException{assertTrue(gate.await(3,TimeUnit.SECONDS),"Controlled barrier timed out");}
    private static Map<String,Object> callbackRace()throws Exception{
        try(var c=new Commands(1);var executor=Executors.newFixedThreadPool(2)){
            var paused=new CountDownLatch(1);var release=new CountDownLatch(1);var calls=new AtomicInteger();
            var samples=mock(LimiterSaturationSamples.class);
            when(samples.enabled()).thenAnswer(i->{if(calls.getAndIncrement()==0){paused.countDown();await(release);}return false;});
            field(RedisRateLimiter.class,"saturation").set(c.limiter,samples);
            var old=c.create();Object next=null;
            var callback=executor.submit(()->{c.observed.invoke(old);return null;});
            int waiting,current,peak;
            try{
                await(paused);
                // Same worker sees get() finish while the Future callback is paused in diagnostics.
                next=executor.submit(()->{c.observed.invoke(old);return c.create();}).get(2,TimeUnit.SECONDS);
                waiting=(((AtomicBoolean)c.waiting.get(old)).get()?1:0)+(((AtomicBoolean)c.waiting.get(next)).get()?1:0);
                current=c.current();peak=c.peak();
            }finally{
                release.countDown();callback.get(3,TimeUnit.SECONDS);
                if(next!=null){c.observed.invoke(next);c.closed.invoke(next);}
            }
            assertEquals(0,c.current());assertEquals(2,c.settlements());
            return Map.of("workers",1,"actualWaitingFlags",waiting,"reportedInFlight",current,"reportedPeak",peak,"settledInFlight",c.current(),"settlements",c.settlements());
        }
    }
    private static void assertCorrect(Map<String,Object> result){
        assertEquals(1,result.get("actualWaitingFlags"));assertEquals(1,result.get("reportedInFlight"));assertEquals(1,result.get("reportedPeak"));
    }
    // Standalone verification reuses this exact compiled test against old and new production classes.
    public static void main(String[] args)throws Exception{
        var result=callbackRace();System.out.println(JsonMapper.builder().build().writeValueAsString(result));assertCorrect(result);
    }
    @Test void retirementPrecedesDiagnosticsAndDuplicateObserverWorkerReuse()throws Exception{assertCorrect(callbackRace());}

    @Test void concurrentReplyAndCloseObserversSettleEachCommandExactlyOnce()throws Exception{
        try(var c=new Commands(4);var executor=Executors.newFixedThreadPool(8)){
            var commands=new Object[]{c.create(),c.create(),c.create(),c.create()};
            assertEquals(4,c.current());assertEquals(4,c.peak());var barrier=new CyclicBarrier(8);
            var work=new java.util.ArrayList<Future<?>>();
            for(var command:commands)for(var method:new Method[]{c.observed,c.closed})work.add(executor.submit(()->{
                barrier.await(3,TimeUnit.SECONDS);method.invoke(command);method.invoke(command);assertTrue(c.current()>=0);return null;
            }));
            for(var future:work)future.get(3,TimeUnit.SECONDS);
            assertEquals(0,c.current());assertEquals(4,c.peak());assertEquals(4,c.settlements());
        }
    }
    @Test @SuppressWarnings("unchecked") void exceptionalFutureResultIsObservedOnceBeforeDuplicateClose()throws Exception{
        try(var c=new Commands(1)){
            Object command=c.create();var reply=mock(RedisFuture.class);var future=new CompletableFuture<String>();
            when(reply.whenComplete(any())).thenAnswer(i->future.whenComplete((BiConsumer<String,Throwable>)i.getArgument(0)));
            var observe=command.getClass().getDeclaredMethod("observe",RedisFuture.class);observe.setAccessible(true);observe.invoke(command,reply);
            future.completeExceptionally(new IllegalStateException("controlled Redis failure"));c.closed.invoke(command);c.observed.invoke(command);
            assertEquals(0,c.current());assertEquals(1,c.peak());assertEquals(1,c.settlements());
            assertEquals(1L,observations(c.limiter).get("commandResultsObserved"));
        }
    }
    @ParameterizedTest @ValueSource(booleans={false,true})
    void cancelledGetRetainsCountUntilPhysicalCloseAndIgnoresLateReply(boolean handoff)throws Exception{
        try(var f=new Fixture(handoff)){
            removeProbeTimer(f.limiter);var entered=new CountDownLatch(1);var closed=new CompletableFuture<Void>();
            when(f.connection.closeAsync()).thenReturn(closed);
            when(f.reply.get(anyLong(),eq(TimeUnit.NANOSECONDS))).thenAnswer(i->{entered.countDown();return f.received.get();});
            var result=f.limiter.decide(SNAPSHOT,"cancel").toFuture();
            try{
                await(entered);assertTrue(result.cancel(true));until(()->((Number)f.limiter.status().get("closing")).intValue()==1);
                assertEquals(1,f.limiter.status().get("commandsInFlight"));assertEquals(1,f.limiter.status().get("peakCommandsInFlight"));
                closed.complete(null);f.drain();f.received.complete(ALLOWED);
                assertSettledAfterClose(f);assertEquals(1L,((Map<?,?>)f.limiter.status().get("outcomes")).get("cancelled"));
            }finally{closed.complete(null);}
        }
    }
    @ParameterizedTest @ValueSource(booleans={false,true})
    void timedOutGetRetainsCountUntilPhysicalCloseAndIgnoresLateReply(boolean handoff)throws Exception{
        try(var f=new Fixture(handoff)){
            removeProbeTimer(f.limiter);var closed=new CompletableFuture<Void>();when(f.connection.closeAsync()).thenReturn(closed);
            when(f.reply.get(anyLong(),eq(TimeUnit.NANOSECONDS))).thenThrow(new TimeoutException("controlled wait deadline"));
            try{
                var result=f.limiter.decide(SNAPSHOT,"timeout").toFuture().get(2,TimeUnit.SECONDS);
                assertEquals("unknown",result.execution());assertEquals("decision_timeout",result.reason());
                until(()->((Number)f.limiter.status().get("closing")).intValue()==1);assertEquals(1,f.limiter.status().get("commandsInFlight"));
                closed.complete(null);f.drain();f.received.complete(ALLOWED);assertSettledAfterClose(f);
            }finally{closed.complete(null);}
        }
    }
    private static void removeProbeTimer(RedisRateLimiter limiter)throws Exception{
        // This fixture owns a single synthetic future. Recovery probes are exercised by live regressions.
        var clock=(ScheduledThreadPoolExecutor)field(RedisRateLimiter.class,"clock").get(limiter);
        for(var job:clock.getQueue())if(job instanceof RunnableScheduledFuture<?> scheduled&&scheduled.isPeriodic())scheduled.cancel(false);
    }
    private static void assertSettledAfterClose(Fixture f){
        assertEquals(0,f.limiter.status().get("commandsInFlight"));assertEquals(1,f.limiter.status().get("peakCommandsInFlight"));
        assertEquals(1L,observations(f.limiter).get("commandsAbandonedAfterClose"));assertEquals(0L,observations(f.limiter).get("commandResultsObserved"));
        assertEquals(0,f.limiter.status().get("retainedTasks"));assertEquals(2,f.limiter.status().get("availableDecisionPermits"));
        assertEquals(0,f.workers.getActiveCount());assertTrue(f.workers.getQueue().isEmpty());
    }
}
