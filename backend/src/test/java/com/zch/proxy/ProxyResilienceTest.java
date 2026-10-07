package com.zch.proxy;

import com.zch.monitor.RequestObservation;
import io.github.resilience4j.circuitbreaker.CircuitBreaker;
import java.net.URI;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.cloud.gateway.route.Route;
import org.springframework.http.HttpStatus;
import org.springframework.mock.http.server.reactive.MockServerHttpRequest;
import org.springframework.mock.web.server.MockServerWebExchange;
import reactor.core.publisher.Mono;
import reactor.test.StepVerifier;
import static org.junit.jupiter.api.Assertions.*;
import static org.springframework.cloud.gateway.support.ServerWebExchangeUtils.GATEWAY_ROUTE_ATTR;

class ProxyResilienceTest {
    final ProxyPolicy policy=new ProxyPolicy();
    MockServerWebExchange exchange(boolean enabled){ return exchange(enabled,"http"); }
    MockServerWebExchange exchange(boolean enabled,String scheme){
        var e=MockServerWebExchange.from(MockServerHttpRequest.get("/proxy"));
        e.getAttributes().put(GATEWAY_ROUTE_ATTR,Route.async().id("one").uri(URI.create(scheme+"://localhost:9000/MiXeD/Target")).predicate(x->true)
                .metadata(ProxyResilienceFilter.ENABLED,enabled).metadata(ProxyResilienceFilter.NAME,"cb-one").build());return e;
    }
    @Test void rejectsInvalidBudgetsAndUnboundedPoolBeforeStartup(){
        for(var pair:List.of(new int[]{0,2000,3000,5000},new int[]{1000,999,3000,5000},new int[]{1000,2000,1999,5000},new int[]{1000,2000,3000,3000})){
            var p=new ProxyPolicy();p.setConnectTimeoutMs(pair[0]);p.setHeadersTimeoutMs(pair[1]);p.setReadIdleTimeoutMs(pair[2]);p.setTotalTimeoutMs(pair[3]);assertThrows(IllegalArgumentException.class,p::validate);
        }
        policy.validate();policy.setMaxPendingAcquires(-1);assertThrows(IllegalArgumentException.class,policy::validate);
    }
    @Test void preservesUpstreamBusinessErrorWhileCountingFailure(){
        var breakers=new ProxyBreakers(policy);var filter=new ProxyResilienceFilter(policy,breakers);var e=exchange(true);
        filter.filter(e,x->{x.getResponse().setStatusCode(HttpStatus.SERVICE_UNAVAILABLE);return x.getResponse().writeWith(Mono.just(x.getResponse().bufferFactory().wrap("business-error".getBytes())));}).block();
        assertEquals(HttpStatus.SERVICE_UNAVAILABLE,e.getResponse().getStatusCode());assertEquals("business-error",e.getResponse().getBodyAsString().block());
        assertEquals(1,breakers.get("cb-one").getMetrics().getNumberOfFailedCalls());
    }
    @Test void aClientErrorIsNotAnUpstreamFailure(){
        var b=new ProxyBreakers(policy);var e=exchange(true);
        new ProxyResilienceFilter(policy,b).filter(e,x->{x.getResponse().setStatusCode(HttpStatus.BAD_REQUEST);return x.getResponse().setComplete();}).block();
        assertEquals(0,b.get("cb-one").getMetrics().getNumberOfFailedCalls());assertEquals(1,b.get("cb-one").getMetrics().getNumberOfSuccessfulCalls());
    }
    @Test void openCircuitNeverSubscribesToTransfer(){
        var b=new ProxyBreakers(policy);b.get("cb-one").transitionToOpenState();var subscribed=new AtomicBoolean();var e=exchange(true);
        new ProxyResilienceFilter(policy,b).filter(e,x->Mono.fromRunnable(()->subscribed.set(true))).block();
        assertFalse(subscribed.get());assertEquals(HttpStatus.SERVICE_UNAVAILABLE,e.getResponse().getStatusCode());assertTrue(e.getResponse().getBodyAsString().block().contains("circuit_open"));
    }
    @Test void cancellingHalfOpenRequestReleasesPermitWithoutRecordingSuccess(){
        policy.setHalfOpenCalls(1);var b=new ProxyBreakers(policy);var circuit=b.get("cb-one");circuit.transitionToOpenState();circuit.transitionToHalfOpenState();
        var subscription=new ProxyResilienceFilter(policy,b).filter(exchange(true),x->Mono.never()).subscribe();
        assertFalse(circuit.tryAcquirePermission());subscription.dispose();assertTrue(circuit.tryAcquirePermission());circuit.releasePermission();
        assertEquals(0,circuit.getMetrics().getNumberOfBufferedCalls());assertEquals(0,b.active.get());
    }
    @Test void bodyCancellationWithCompletedWriterDoesNotBecomeSuccessfulHalfOpenProbe() {
        policy.setHalfOpenCalls(1);
        var b=new ProxyBreakers(policy);var circuit=b.get("cb-one");
        circuit.transitionToOpenState();circuit.transitionToHalfOpenState();
        var e=exchange(true);var observation=new RequestObservation();
        // Models the real transport completing send() when the peer closed after one chunk.
        e.getResponse().setWriteHandler(body->body.next().then());
        new ProxyResilienceFilter(policy,b).filter(e,x->{
            x.getResponse().setStatusCode(HttpStatus.OK);
            var body=reactor.core.publisher.Flux.concat(Mono.just(x.getResponse().bufferFactory().wrap("prefix".getBytes())),Mono.never());
            return x.getResponse().writeWith(body);
        }).contextWrite(c->c.put(RequestObservation.CONTEXT_KEY,observation)).block();
        assertEquals("client_cancelled",observation.reason);
        assertEquals(0,circuit.getMetrics().getNumberOfBufferedCalls());
        assertEquals(CircuitBreaker.State.HALF_OPEN,circuit.getState());
        assertTrue(circuit.tryAcquirePermission());circuit.releasePermission();
        assertEquals(HttpStatus.OK,e.getResponse().getStatusCode());assertEquals(0,b.active.get());
    }
    @Test void totalBudgetAlsoProtectsRoutesWithoutBreakersAndCancelsWork(){
        var b=new ProxyBreakers(policy);var cancelled=new AtomicBoolean();var e=exchange(false);
        StepVerifier.withVirtualTime(()->new ProxyResilienceFilter(policy,b).filter(e,x->Mono.<Void>never().doOnCancel(()->cancelled.set(true))))
                .thenAwait(Duration.ofSeconds(5)).verifyComplete();
        assertTrue(cancelled.get());assertEquals(HttpStatus.GATEWAY_TIMEOUT,e.getResponse().getStatusCode());assertTrue(e.getResponse().getBodyAsString().block().contains("proxy_total_timeout"));
    }
    @Test void committedResponseErrorNeverAppendsJsonOrChangesStatus(){
        var b=new ProxyBreakers(policy);var e=exchange(true);var observation=new RequestObservation();
        StepVerifier.withVirtualTime(()->new ProxyResilienceFilter(policy,b).filter(e,x->x.getResponse().setComplete().then(Mono.never()))
                .contextWrite(c->c.put(RequestObservation.CONTEXT_KEY,observation)))
                .thenAwait(Duration.ofSeconds(5)).expectError(ProxyFailure.TotalTimeout.class).verify();
        assertTrue(e.getResponse().isCommitted());assertNull(e.getResponse().getStatusCode());assertEquals("",e.getResponse().getBodyAsString().defaultIfEmpty("").block());
        assertEquals("proxy_total_timeout",observation.reason);assertEquals(1,b.get("cb-one").getMetrics().getNumberOfFailedCalls());
    }
    @Test void classificationTraversesWrappersAndDistinguishesTimeoutAndConnectFailure(){
        assertEquals(502,ProxyFailure.classify(new RuntimeException(new java.net.ConnectException())).status());
        assertEquals("upstream_connect_timeout",ProxyFailure.classify(new io.netty.channel.ConnectTimeoutException()).reason());
        assertEquals("upstream_read_idle",ProxyFailure.classify(io.netty.handler.timeout.ReadTimeoutException.INSTANCE).reason());
        assertEquals(504,ProxyFailure.classify(new org.springframework.web.server.ResponseStatusException(HttpStatus.GATEWAY_TIMEOUT,"deadline",new org.springframework.cloud.gateway.support.TimeoutException("headers"))).status());
        assertFalse(ProxyFailure.classify(new IllegalArgumentException()).breakerFailure());
    }
    @Test void explicitNameSharesStateAndDefaultNamesRemainIndependent(){
        var b=new ProxyBreakers(policy);assertSame(b.get("shared"),b.get("shared"));b.get("cb-one").transitionToOpenState();assertEquals(CircuitBreaker.State.CLOSED,b.get("cb-two").getState());
    }
    @ParameterizedTest
    @ValueSource(strings={"http","HTTP","HtTp","https","HTTPS","HtTpS"})
    void allHttpSchemesGetTotalDeadlineWithoutChangingUri(String scheme) {
        var b=new ProxyBreakers(policy);var e=exchange(false,scheme);var cancelled=new AtomicBoolean();
        var original=e.<Route>getRequiredAttribute(GATEWAY_ROUTE_ATTR).getUri();
        StepVerifier.withVirtualTime(()->new ProxyResilienceFilter(policy,b).filter(e,
                        x->Mono.<Void>never().doOnCancel(()->cancelled.set(true))))
                .thenAwait(Duration.ofSeconds(5)).expectComplete().verify(Duration.ofSeconds(2));
        assertTrue(cancelled.get());assertEquals(HttpStatus.GATEWAY_TIMEOUT,e.getResponse().getStatusCode());
        assertEquals(original,e.<Route>getRequiredAttribute(GATEWAY_ROUTE_ATTR).getUri());
        assertEquals("/MiXeD/Target",original.getPath());assertEquals(0,b.active.get());
    }
    @ParameterizedTest
    @ValueSource(strings={"http","HTTP","HtTp","https","HTTPS","HtTpS"})
    void allHttpSchemesRecordUpstreamFailuresAndRejectWhenOpen(String scheme) {
        policy.setMinimumCalls(2);policy.setSlidingWindowSize(2);
        var b=new ProxyBreakers(policy);var filter=new ProxyResilienceFilter(policy,b);
        for(int i=0;i<2;i++) {
            var e=exchange(true,scheme);var o=new RequestObservation();
            filter.filter(e,x->{x.getResponse().setStatusCode(HttpStatus.INTERNAL_SERVER_ERROR);return x.getResponse().setComplete();})
                    .contextWrite(c->c.put(RequestObservation.CONTEXT_KEY,o)).block();
            assertEquals("upstream_5xx",o.reason);assertEquals(HttpStatus.INTERNAL_SERVER_ERROR,e.getResponse().getStatusCode());
        }
        assertEquals(2,b.get("cb-one").getMetrics().getNumberOfFailedCalls());
        assertEquals(CircuitBreaker.State.OPEN,b.get("cb-one").getState());
        var e=exchange(true,scheme);var contacted=new AtomicBoolean();
        filter.filter(e,x->Mono.fromRunnable(()->contacted.set(true))).block();
        assertFalse(contacted.get());assertEquals(HttpStatus.SERVICE_UNAVAILABLE,e.getResponse().getStatusCode());
    }
    @ParameterizedTest
    @ValueSource(strings={"http","HTTP","HtTp","https","HTTPS","HtTpS"})
    void allHttpSchemesReleaseCancelledProbeWithoutCountingSuccess(String scheme) {
        policy.setHalfOpenCalls(1);var b=new ProxyBreakers(policy);var circuit=b.get("cb-one");
        circuit.transitionToOpenState();circuit.transitionToHalfOpenState();var cancelled=new AtomicBoolean();
        var subscription=new ProxyResilienceFilter(policy,b).filter(exchange(true,scheme),
                x->Mono.<Void>never().doOnCancel(()->cancelled.set(true))).subscribe();
        assertEquals(1,b.active.get());assertFalse(circuit.tryAcquirePermission());
        subscription.dispose();assertTrue(cancelled.get());assertEquals(0,b.active.get());
        assertEquals(0,circuit.getMetrics().getNumberOfBufferedCalls());
        assertTrue(circuit.tryAcquirePermission());circuit.releasePermission();
    }

}
