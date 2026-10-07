package com.zch.proxy;

import io.github.resilience4j.circuitbreaker.CircuitBreaker;
import io.github.resilience4j.circuitbreaker.CircuitBreakerConfig;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import org.springframework.stereotype.Component;

/** Local state, shared only by explicit breaker name. No Redis I/O in proxy admission. */
@Component
public class ProxyBreakers {
    private final CircuitBreakerConfig config;
    private final ProxyPolicy policy;
    private final ConcurrentHashMap<String,Entry> entries=new ConcurrentHashMap<>();
    final AtomicInteger active=new AtomicInteger();
    public ProxyBreakers(ProxyPolicy policy) {
        this.policy=policy;
        config=CircuitBreakerConfig.custom().slidingWindowSize(policy.getSlidingWindowSize()).minimumNumberOfCalls(policy.getMinimumCalls())
                .failureRateThreshold(policy.getFailureRateThreshold()).waitDurationInOpenState(Duration.ofMillis(policy.getOpenWaitMs()))
                .permittedNumberOfCallsInHalfOpenState(policy.getHalfOpenCalls()).automaticTransitionFromOpenToHalfOpenEnabled(false)
                .slowCallDurationThreshold(Duration.ofMillis(policy.getTotalTimeoutMs()+1000L))
                .ignoreException(e->!ProxyFailure.classify(e).breakerFailure())
                .recordResult(result->result instanceof Integer status && status>=500 && status<=599).build();
    }
    public CircuitBreaker get(String name){return entries.computeIfAbsent(name,n->new Entry(n,config)).breaker;}
    public Map<String,Object> diagnostics(){
        var body=new LinkedHashMap<String,Object>();body.put("source","local");body.put("observedAt",Instant.now().toString());body.put("policy",policy.values());body.put("activeProxyRequests",active.get());
        body.put("breakers",entries.entrySet().stream().sorted(Map.Entry.comparingByKey()).map(e->{
            var entry=e.getValue();var b=entry.breaker;var m=b.getMetrics();var item=new LinkedHashMap<String,Object>();
            item.put("name",e.getKey());item.put("state",b.getState().name());item.put("lastTransition",entry.lastTransition);
            item.put("lastTransitionAt",entry.transitionAt);item.put("bufferedCalls",m.getNumberOfBufferedCalls());
            item.put("successfulCalls",m.getNumberOfSuccessfulCalls());item.put("failedCalls",m.getNumberOfFailedCalls());
            item.put("notPermittedCalls",m.getNumberOfNotPermittedCalls());item.put("failureRate",m.getFailureRate());
            item.put("probeEligibleInMs",b.getState()==CircuitBreaker.State.OPEN?Math.max(0,policy.getOpenWaitMs()-(System.nanoTime()-entry.openedAt)/1_000_000):0);
            return item;
        }).toList());return body;
    }
    private static final class Entry {
        final CircuitBreaker breaker;
        volatile String lastTransition="NONE",transitionAt=null;
        volatile long openedAt;
        Entry(String name,CircuitBreakerConfig config){
            breaker=CircuitBreaker.of(name,config);
            breaker.getEventPublisher().onStateTransition(e->{
                lastTransition=e.getStateTransition().name();transitionAt=e.getCreationTime().toString();
                if(e.getStateTransition().getToState()==CircuitBreaker.State.OPEN)openedAt=System.nanoTime();
            });
        }
    }
}
