package com.zch.config;

import java.util.Map;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.springframework.data.redis.core.*;
import reactor.core.publisher.Mono;
import tools.jackson.databind.json.JsonMapper;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class RuntimeConfigLegacyEvidenceTest {
    final JsonMapper mapper = JsonMapper.builder().build();
    final AtomicReference<String> stored = new AtomicReference<>();
    @SuppressWarnings("unchecked")
    RuntimeConfigPersistence persistence(GatewayRuntimeProperties props, boolean loseReply) {
        var redis=mock(ReactiveStringRedisTemplate.class);
        ReactiveValueOperations<String,String> ops=mock(ReactiveValueOperations.class);
        when(redis.opsForValue()).thenReturn(ops);
        when(ops.set(anyString(),anyString())).thenAnswer(call -> Mono.defer(()->{
            stored.set(call.getArgument(1));
            return loseReply ? Mono.error(new IllegalStateException("reply lost after write")) : Mono.just(true);
        }));
        return new RuntimeConfigPersistence(redis,mapper,props);
    }
    RuntimeConfigController controller(GatewayRuntimeProperties p, boolean loseReply) {
        return new RuntimeConfigController(p,persistence(p,loseReply),new AdminAuthProperties());
    }
    static void waitFor(CountDownLatch latch) {
        try { assertTrue(latch.await(3,TimeUnit.SECONDS)); }
        catch(InterruptedException e){Thread.currentThread().interrupt();throw new AssertionError(e);}
    }
    @Test void staleWholeFormOverwritesEarlierWindow() {
        var p=new GatewayRuntimeProperties();var c=controller(p,false);
        var a=c.current().block();var b=c.current().block();
        a.put("monitorWindowSeconds",30);assertEquals(30,c.update(a).block().get("monitorWindowSeconds"));
        b.put("replenishRate",40);assertEquals(10,c.update(b).block().get("monitorWindowSeconds"));
        System.out.println("EVIDENCE stale form: A window=30, B accepted and window=10");
    }
    @Test void readBetweenTheTwoPublicationsObservesAMixedConfiguration() throws Exception {
        var entered=new CountDownLatch(1);var release=new CountDownLatch(1);
        var p=new GatewayRuntimeProperties(){
            @Override public RateLimitConfig updateRateLimit(RateLimitConfig next){
                var result=super.updateRateLimit(next);entered.countDown();waitFor(release);return result;
            }
        };
        var c=controller(p,false);
        try(var executor=Executors.newSingleThreadExecutor()){
            var write=executor.submit(()->c.update(Map.of("replenishRate",40,"monitorWindowSeconds",30)).block());
            try{waitFor(entered);var mixed=c.current().block();assertEquals(40,mixed.get("replenishRate"));assertEquals(10,mixed.get("monitorWindowSeconds"));}
            finally{release.countDown();}
            write.get(3,TimeUnit.SECONDS);
        }
        System.out.println("EVIDENCE read between atomic groups: rate=40/window=10, desired=40/30");
    }
    @Test void firstResponseCanContainSecondCommitsValues() throws Exception {
        var entered=new CountDownLatch(1);var release=new CountDownLatch(1);
        var p=new GatewayRuntimeProperties(){
            @Override public MonitorConfig updateMonitor(MonitorConfig next){
                var result=super.updateMonitor(next);if(next.windowSeconds()==30){entered.countDown();waitFor(release);}return result;
            }
        };
        var c=controller(p,false);
        try(var executor=Executors.newSingleThreadExecutor()){
            var a=executor.submit(()->c.update(Map.of("monitorWindowSeconds",30)).block());
            try{waitFor(entered);assertEquals(40,c.update(Map.of("monitorWindowSeconds",40)).block().get("monitorWindowSeconds"));}
            finally{release.countDown();}
            assertEquals(40,a.get(3,TimeUnit.SECONDS).get("monitorWindowSeconds"));
        }
        System.out.println("EVIDENCE A submitted 30 but successful response contains B window=40");
    }
    @Test void lostStoreReplyLeavesMemoryAndGetOldDespiteStoredWrite() throws Exception {
        var p=new GatewayRuntimeProperties();var c=controller(p,true);
        assertThrows(IllegalStateException.class,()->c.update(Map.of("monitorWindowSeconds",30)).block());
        assertEquals(30,mapper.readValue(stored.get(),Map.class).get("monitorWindowSeconds"));
        assertEquals(10,c.current().block().get("monitorWindowSeconds"));
        System.out.println("EVIDENCE controlled store reply loss: stored=30, memory/GET=10 (mock boundary)");
    }
}
