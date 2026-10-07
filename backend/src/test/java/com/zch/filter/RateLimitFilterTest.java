package com.zch.filter;
import com.zch.config.*;
import com.zch.ratelimit.*;
import com.zch.monitor.*;
import com.zch.util.ClientIpResolver;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.*;
import org.springframework.mock.http.server.reactive.MockServerHttpRequest;
import org.springframework.mock.web.server.MockServerWebExchange;
import reactor.core.publisher.Mono;
import reactor.test.StepVerifier;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class RateLimitFilterTest {
    RateLimitDecider decider;GatewayRuntimeProperties properties;SimpleMeterRegistry registry;RateLimitFilter filter;
    @BeforeEach void setup(){
        decider=mock(RateLimitDecider.class);properties=new GatewayRuntimeProperties();registry=new SimpleMeterRegistry();
        filter=new RateLimitFilter(decider,properties,new ClientIpResolver(new ProxyProperties()),new GatewayMetrics(registry,true,new org.springframework.boot.availability.ApplicationAvailabilityBean()));
    }
    MockServerWebExchange exchange(){return MockServerWebExchange.from(MockServerHttpRequest.get("/proxy"));}
    void decision(String outcome,String reason,Long retry){when(decider.decide(any(),anyString())).thenReturn(Mono.just(new LimitDecision(outcome,reason,"confirmed",retry,null,0L,null,null,null,10,1,5,false)));}
    @Test void disabledDecisionStillForwardsWithoutRedisMeasurement(){
        properties.setRateLimit(properties.getRateLimit().withEnabled(false));decision("disabled","disabled",null);
        var e=exchange();filter.filter(e,x->x.getResponse().setComplete()).block();assertEquals(0,registry.get("zenith.ratelimit.redis").tag("outcome","error").timer().count());
    }
    @Test void exhaustedQuotaStopsTheChain(){
        decision("limited","quota_exhausted",5L);var e=exchange();var called=new java.util.concurrent.atomic.AtomicBoolean();
        filter.filter(e,x->Mono.fromRunnable(()->called.set(true))).block();assertFalse(called.get());assertEquals(429,e.getResponse().getStatusCode().value());
        assertEquals(1,registry.get("zenith.ratelimit.redis").tag("outcome","limited").timer().count());
    }
    @Test void allowedDecisionForwards(){
        decision("allowed","quota_available",null);var called=new java.util.concurrent.atomic.AtomicBoolean();
        filter.filter(exchange(),x->Mono.fromRunnable(()->called.set(true))).block();assertTrue(called.get());
    }
    @Test void retryAfterUsesAtomicDecisionAndResponseCannotBeCached(){
        decision("limited","quota_exhausted",5L);var e=exchange();filter.filter(e,x->Mono.empty()).block();
        assertEquals("5",e.getResponse().getHeaders().getFirst("Retry-After"));assertEquals("no-store",e.getResponse().getHeaders().getCacheControl());
        assertTrue(e.getResponse().getBodyAsString().block().contains("\"retryAfterSeconds\":5"));
    }
    @Test void impossibleCostDoesNotAdvertiseFutureAvailability(){
        decision("unfulfillable","cost_exceeds_capacity",null);var e=exchange();filter.filter(e,x->Mono.empty()).block();
        assertEquals(429,e.getResponse().getStatusCode().value());assertNull(e.getResponse().getHeaders().getFirst("Retry-After"));
        assertTrue(e.getResponse().getBodyAsString().block().contains("cost_exceeds_capacity"));
    }
    @Test void redisFailureForwardsButRetainsIndependentAuditDecision(){
        decision("redis_fail_open","decision_timeout",null);var o=new RequestObservation();
        filter.filter(exchange(),x->Mono.fromRunnable(()->o.reason="upstream_5xx")).contextWrite(c->c.put(RequestObservation.CONTEXT_KEY,o)).block();
        assertEquals("redis_fail_open",o.rateLimitOutcome);assertEquals("decision_timeout",o.rateLimitReason);assertEquals("upstream_5xx",o.reason);
        assertEquals(1,registry.get("zenith.ratelimit.redis").tag("outcome","error").timer().count());
    }
    @Test void measurementEndsBeforeUpstreamAndItsLaterCancellationDoesNotCancelTheDecision(){
        decision("allowed","quota_available",null);var o=new RequestObservation();
        var d=filter.filter(exchange(),x->{
            assertEquals(1,registry.get("zenith.ratelimit.redis").tag("outcome","allowed").timer().count(),"Measure before synchronous downstream construction");
            return Mono.never();
        }).contextWrite(c->c.put(RequestObservation.CONTEXT_KEY,o)).subscribe();
        assertEquals(1,registry.get("zenith.ratelimit.redis").tag("outcome","allowed").timer().count());d.dispose();
        assertEquals("allowed",o.rateLimitOutcome);assertEquals(0,registry.get("zenith.ratelimit.redis").tag("outcome","cancelled").timer().count());
    }
    @Test void pendingDecisionCancellationIsDistinct(){
        when(decider.decide(any(),anyString())).thenReturn(Mono.never());var o=new RequestObservation();
        StepVerifier.create(filter.filter(exchange(),x->Mono.empty()).contextWrite(c->c.put(RequestObservation.CONTEXT_KEY,o))).thenCancel().verify();
        assertEquals("cancelled",o.rateLimitOutcome);assertEquals(1,registry.get("zenith.ratelimit.redis").tag("outcome","cancelled").timer().count());
    }
    @Test void handsOffOneCompleteSnapshotWithItsVersion(){
        var snapshot=new RuntimeConfigSnapshot("11111111-1111-1111-1111-111111111111:3",new RateLimitConfig(true,7,13,2),MonitorConfig.defaults());properties.adopt(snapshot);
        decision("allowed","quota_available",null);filter.filter(exchange(),x->Mono.empty()).block();verify(decider).decide(same(snapshot),eq("unknown"));
    }
    @Test void cancellationAfterTerminalDecisionBeforeDeliveryKeepsItsChosenQuotaOutcome() {
        // The Redis worker already selected its result; downstream has not received onNext yet.
        when(decider.decide(any(),anyString())).thenReturn(Mono.deferContextual(context -> {
            var observation=context.<RequestObservation>get(RequestObservation.CONTEXT_KEY);
            observation.rateLimitOutcome="allowed";
            observation.rateLimitReason="quota_available";
            return Mono.never();
        }));
        var observation=new RequestObservation();
        var request=filter.filter(exchange(),x->Mono.empty())
                .contextWrite(c->c.put(RequestObservation.CONTEXT_KEY,observation)).subscribe();
        request.dispose();
        assertEquals("allowed",observation.rateLimitOutcome);
        assertEquals(1,registry.get("zenith.ratelimit.redis").tag("outcome","allowed").timer().count());
        assertEquals(0,registry.get("zenith.ratelimit.redis").tag("outcome","cancelled").timer().count());
    }

    @Test void strictFailuresStopUpstreamAndKeepTheirExecutionUncertainty(){
        for(String family:new String[]{"local","redis"}){
            var d=LimitDecision.local(family+"_rejected",family.equals("local")?"queue_full":"decision_timeout",
                    family.equals("local")?"not_sent":"unknown",family.equals("local")?"executor_rejected":null);
            when(decider.decide(any(),anyString())).thenReturn(Mono.just(d));var e=exchange();var o=new RequestObservation();
            filter.filter(e,x->{fail("503 must not invoke upstream");return Mono.empty();})
                    .contextWrite(c->c.put(RequestObservation.CONTEXT_KEY,o)).block();
            assertEquals(503,e.getResponse().getStatusCode().value());assertNull(e.getResponse().getHeaders().getFirst("Retry-After"));
            assertEquals("no-store",e.getResponse().getHeaders().getCacheControl());
            var json=tools.jackson.databind.json.JsonMapper.builder().build().readTree(e.getResponse().getBodyAsString().block());
            assertEquals("reject",json.get("limitAction").asText());assertEquals(d.execution(),json.get("limitExecution").asText());
            assertEquals(d.event(),o.rateLimitEvent);assertEquals("reject",o.rateLimitAction);assertEquals(d.execution(),o.rateLimitExecution);
            assertEquals("limiter_"+d.event(),o.reason);
        }
    }

}
