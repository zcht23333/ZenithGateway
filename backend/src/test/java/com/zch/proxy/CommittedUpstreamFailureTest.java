package com.zch.proxy;

import com.zch.config.GatewayRuntimeProperties;
import com.zch.config.ProxyProperties;
import com.zch.filter.AuditLogFilter;
import com.zch.monitor.*;
import com.zch.util.ClientIpResolver;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.net.SocketException;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.mockito.ArgumentCaptor;
import org.springframework.boot.availability.ApplicationAvailabilityBean;
import org.springframework.cloud.gateway.route.Route;
import org.springframework.mock.http.server.reactive.MockServerHttpRequest;
import org.springframework.mock.http.server.reactive.MockServerHttpResponse;
import org.springframework.web.server.adapter.WebHttpHandlerBuilder;
import reactor.core.publisher.Mono;
import reactor.test.StepVerifier;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.springframework.cloud.gateway.support.ServerWebExchangeUtils.GATEWAY_ROUTE_ATTR;

class CommittedUpstreamFailureTest {
    @ParameterizedTest
    @ValueSource(strings={"recvAddress(..) failed: Connection reset by peer", "Broken pipe", "Connection reset"})
    void realWebAdapterPropagatesUpstreamFailureAndRecordsOneError(String message) {
        var properties=new GatewayRuntimeProperties();
        var audit=mock(AuditEventPublisher.class);
        var registry=new SimpleMeterRegistry();
        var metrics=new TrafficMetricsService(properties,registry,true);
        var recorder=new RequestCompletionRecorder(metrics,audit,new ClientIpResolver(new ProxyProperties()),properties,
                new GatewayMetrics(registry,true,new ApplicationAvailabilityBean()));
        var policy=new ProxyPolicy();var breakers=new ProxyBreakers(policy);
        var proxy=new ProxyResilienceFilter(policy,breakers);
        var failure=UpstreamTransportErrors.mark(new SocketException(message));
        var marker=new AuditLogFilter();
        var handler=recorder.apply(WebHttpHandlerBuilder.webHandler(exchange->marker.filter(exchange,forwarded->{
            exchange.getAttributes().put(GATEWAY_ROUTE_ATTR,Route.async().id("reset").uri("http://localhost:9000")
                    .predicate(e->true).metadata(ProxyResilienceFilter.ENABLED,true).metadata(ProxyResilienceFilter.NAME,"cb-reset").build());
            return proxy.filter(exchange,e->e.getResponse().writeWith(Mono.just(e.getResponse().bufferFactory().wrap("prefix".getBytes())))
                    .then(Mono.error(failure)));
        })).build());
        var response=new MockServerHttpResponse();
        StepVerifier.create(handler.handle(MockServerHttpRequest.get("/reset").build(),response))
                .expectErrorMatches(error->error==failure).verify();
        assertTrue(response.isCommitted());assertEquals("prefix",response.getBodyAsString().block());
        var capture=ArgumentCaptor.forClass(TrafficData.class);verify(audit,times(1)).publish(capture.capture());
        assertEquals(200,capture.getValue().getStatusCode());assertEquals("error",capture.getValue().getOutcome());
        assertEquals("upstream_disconnect",capture.getValue().getReason());
        assertEquals(1,metrics.latestSnapshot().getCompletedTotal());
        assertEquals(1,breakers.get("cb-reset").getMetrics().getNumberOfFailedCalls());assertEquals(0,breakers.active.get());
    }

    @Test void rawDownstreamDisconnectStillUsesFrameworkHandling() {
        var response=new MockServerHttpResponse();
        var handler=WebHttpHandlerBuilder.webHandler(exchange->exchange.getResponse().setComplete()
                .then(Mono.error(new SocketException("Connection reset by peer")))).build();
        StepVerifier.create(handler.handle(MockServerHttpRequest.get("/downstream").build(),response)).verifyComplete();
    }
}
