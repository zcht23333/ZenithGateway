package com.zch.ratelimit;

import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class LimiterSaturationSamplesTest {
    @Test void disabledNeverInspectsRequestState(){
        var samples=new LimiterSaturationSamples(false);samples.capture("admission_full",()->{fail("Disabled sampler must be free of state collection");return Map.of();});
        assertEquals(0L,samples.status().get("offered"));assertTrue(((List<?>)samples.status().get("samples")).isEmpty());
    }
    @Test void intervalAndRingAreBounded(){
        var now=new AtomicLong(1);var samples=new LimiterSaturationSamples(true,now::get,()->1234L);
        for(int i=0;i<384;i++){
            now.addAndGet(LimiterSaturationSamples.INTERVAL_NANOS);samples.capture("admission_full",()->Map.of("count",1));
            samples.capture("admission_full",()->{fail("Second capture in the same interval");return Map.of();});
        }
        var state=samples.status();var events=(List<?>)state.get("samples");
        assertEquals(768L,state.get("offered"));assertEquals(384L,state.get("suppressed"));assertEquals(128,events.size());
        assertEquals(257L,((LimiterSaturationSamples.Sample)events.getFirst()).sequence());assertEquals(384L,((LimiterSaturationSamples.Sample)events.getLast()).sequence());
        assertEquals(true,samples.since(1).get("cursorTooOld"));assertEquals(1,((List<?>)samples.since(383).get("samples")).size());
        assertTrue(((List<?>)samples.since(384).get("samples")).isEmpty());assertFalse(samples.summary().containsKey("samples"));
    }
    @Test void simultaneousRejectionsCollectAtMostOnce()throws Exception{
        var samples=new LimiterSaturationSamples(true,()->1000L,()->1L);var start=new CountDownLatch(1);
        var count=new AtomicInteger();try(var executor=Executors.newFixedThreadPool(8)){
            var futures=new ArrayList<Future<?>>();
            for(int i=0;i<32;i++)futures.add(executor.submit(()->{try{assertTrue(start.await(2,TimeUnit.SECONDS));}catch(InterruptedException e){throw new RuntimeException(e);}samples.capture("admission_full",()->{count.incrementAndGet();return Map.of();});}));
            start.countDown();for(var future:futures)future.get(3,TimeUnit.SECONDS);
        }
        assertEquals(1,count.get());assertEquals(31L,samples.status().get("suppressed"));
    }
    @Test void observationFailureCannotChangeTheDecision(){
        var samples=new LimiterSaturationSamples(true,()->1000L,()->1L);
        assertDoesNotThrow(()->samples.capture("executor_rejected",()->{throw new IllegalStateException("test fixture");}));
        assertEquals(1L,samples.status().get("captureErrors"));assertTrue(((List<?>)samples.status().get("samples")).isEmpty());
    }
}
