package com.zch.monitor;

import com.zch.config.GatewayRuntimeProperties;
import com.zch.config.ProxyProperties;
import com.zch.filter.AuditLogFilter;
import com.zch.util.ClientIpResolver;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.reactive.HttpHandler;
import org.springframework.mock.http.server.reactive.MockServerHttpRequest;
import org.springframework.mock.http.server.reactive.MockServerHttpResponse;
import org.springframework.web.server.WebHandler;
import org.springframework.web.server.adapter.WebHttpHandlerBuilder;
import reactor.core.publisher.Mono;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class RequestCompletionRecorderTest {
    private final SimpleMeterRegistry externalMetrics = new SimpleMeterRegistry();
    private final GatewayRuntimeProperties properties = new GatewayRuntimeProperties();
    private final AuditEventPublisher audit = mock(AuditEventPublisher.class);
    private final TrafficMetricsService metrics = new TrafficMetricsService(properties, new SimpleMeterRegistry(), true);
    private final RequestCompletionRecorder recorder = new RequestCompletionRecorder(metrics, audit,
            new ClientIpResolver(new ProxyProperties()), properties,
            new GatewayMetrics(externalMetrics, true, new org.springframework.boot.availability.ApplicationAvailabilityBean()));
    private final AuditLogFilter marker = new AuditLogFilter();

    private HttpHandler handler(WebHandler target) {
        return recorder.apply(WebHttpHandlerBuilder.webHandler(exchange -> marker.filter(exchange, target::handle))
                .exceptionHandler((exchange, error) -> {
                    exchange.getResponse().setStatusCode(HttpStatus.SERVICE_UNAVAILABLE);
                    return exchange.getResponse().setComplete();
                }).build());
    }
    private TrafficData recorded() {
        var capture = ArgumentCaptor.forClass(TrafficData.class);
        verify(audit, times(1)).publish(capture.capture());
        assertEquals(1, metrics.latestSnapshot().getCompletedTotal());
        assertEquals(1, externalMetrics.find("zenith.gateway.requests").timers().stream().mapToLong(t -> t.count()).sum());
        return capture.getValue();
    }

    @Test void capturesFinalErrorResponseAfterExceptionHandler() {
        handler(exchange -> Mono.error(new IllegalStateException("upstream failed")))
                .handle(MockServerHttpRequest.get("/proxy").build(), new MockServerHttpResponse()).block();
        assertEquals(503, recorded().getStatusCode());
    }

    @Test void capturesRateLimitAndUpstreamErrors() {
        handler(exchange -> {
            exchange.getResponse().setStatusCode(HttpStatus.TOO_MANY_REQUESTS);
            return exchange.getResponse().setComplete();
        }).handle(MockServerHttpRequest.get("/proxy").build(), new MockServerHttpResponse()).block();
        assertEquals(429, recorded().getStatusCode());
    }

    @Test void internalForwardIsRecordedOnceAndUsesFinalFallbackStatus() {
        handler(exchange -> marker.filter(exchange, forwarded -> {
            forwarded.getResponse().setStatusCode(HttpStatus.BAD_GATEWAY);
            return forwarded.getResponse().setComplete();
        })).handle(MockServerHttpRequest.get("/proxy").build(), new MockServerHttpResponse()).block();
        assertEquals(502, recorded().getStatusCode());
    }

    @Test void uncommittedCancellationDoesNotInventHttp200() {
        var subscription = handler(exchange -> Mono.never())
                .handle(MockServerHttpRequest.get("/proxy").build(), new MockServerHttpResponse()).subscribe();
        subscription.dispose();
        var data = recorded();
        assertEquals("cancelled", data.getOutcome());
        assertEquals(0, data.getStatusCode());
    }

    @Test void managementRequestsAreExcluded() {
        recorder.apply(WebHttpHandlerBuilder.webHandler(exchange -> exchange.getResponse().setComplete()).build())
                .handle(MockServerHttpRequest.get("/settings/runtime").build(), new MockServerHttpResponse()).block();
        verifyNoInteractions(audit);
        assertEquals(0, metrics.latestSnapshot().getCompletedTotal());
        assertEquals(0, externalMetrics.find("zenith.gateway.requests").timers().stream().mapToLong(t -> t.count()).sum());
    }

    @Test void disablingAuditPreservesMonitoring() {
        properties.getAudit().setEnabled(false);
        handler(exchange -> exchange.getResponse().setComplete())
                .handle(MockServerHttpRequest.get("/proxy").build(), new MockServerHttpResponse()).block();
        verifyNoInteractions(audit);
        assertEquals(1, metrics.latestSnapshot().getCompletedTotal());
    }

    @Test void committedCancellationKeepsTheHttpStatus() {
        var response = new MockServerHttpResponse();
        var subscription = handler(exchange -> exchange.getResponse().setComplete().then(Mono.never()))
                .handle(MockServerHttpRequest.get("/proxy").build(), response).subscribe();
        assertTrue(response.isCommitted());
        subscription.dispose();
        var data = recorded();
        assertEquals(200, data.getStatusCode());
        assertEquals("cancelled", data.getOutcome());
    }

    @Test void transportCompleteAfterBodyCancellationRecordsCancellationExactlyOnce() {
        handler(exchange -> Mono.deferContextual(context -> {
            context.<RequestObservation>get(RequestObservation.CONTEXT_KEY).reason="client_cancelled";
            exchange.getResponse().setStatusCode(HttpStatus.OK);
            return exchange.getResponse().setComplete();
        })).handle(MockServerHttpRequest.get("/proxy").build(),new MockServerHttpResponse()).block();
        var data=recorded();assertEquals(200,data.getStatusCode());assertEquals("cancelled",data.getOutcome());
        assertEquals("client_cancelled",data.getReason());
        assertEquals(1,externalMetrics.get("zenith.gateway.proxy.outcomes").tag("reason","client_cancelled").counter().count());
    }
    @Test void unhandledFailureWithoutResponseHasUnknownStatus() {
        HttpHandler failing = (request, response) -> Mono.deferContextual(context -> {
            context.<RequestObservation>get(RequestObservation.CONTEXT_KEY).markProxied();
            return Mono.error(new IllegalStateException("unhandled"));
        });
        assertThrows(IllegalStateException.class, () -> recorder.apply(failing)
                .handle(MockServerHttpRequest.get("/proxy").build(), new MockServerHttpResponse()).block());
        var data = recorded();
        assertEquals(0, data.getStatusCode());
        assertEquals("error", data.getOutcome());
    }

    @Test void rejectedUnknownQuotaKeepsFactActionAndFinalResultSeparately(){
        handler(exchange->Mono.deferContextual(c->{
            var o=c.<RequestObservation>get(RequestObservation.CONTEXT_KEY);
            o.limiter(com.zch.ratelimit.LimitDecision.local("redis_rejected","decision_timeout","unknown"));
            o.reason="limiter_redis_unconfirmed";o.phase="rate_limit";
            exchange.getResponse().setStatusCode(HttpStatus.SERVICE_UNAVAILABLE);return exchange.getResponse().setComplete();
        })).handle(MockServerHttpRequest.get("/proxy").build(),new MockServerHttpResponse()).block();
        var data=recorded();assertEquals(503,data.getStatusCode());assertEquals("http_error",data.getOutcome());
        var event=AuditEvent.copyOf(data,"test");
        assertEquals("redis_unconfirmed",event.rateLimitEvent());assertEquals("reject",event.rateLimitAction());assertEquals("unknown",event.rateLimitExecution());
        assertEquals("limiter_redis_unconfirmed",event.reason());
        assertEquals(1,externalMetrics.get("zenith.gateway.proxy.outcomes").tag("reason","limiter_redis_unconfirmed").counter().count());
        var old=new AuditEvent("old",0,"GET","/",200,1,"local","completed");
        var json=tools.jackson.databind.json.JsonMapper.builder().build().writeValueAsString(old);
        assertFalse(json.contains("rateLimitExecution"));
    }

}
