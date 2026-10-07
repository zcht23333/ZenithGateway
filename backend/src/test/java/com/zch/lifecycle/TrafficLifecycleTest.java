package com.zch.lifecycle;

import com.zch.config.GatewayRuntimeProperties;
import com.zch.filter.ReadinessFilter;
import com.zch.monitor.AuditBatchWriter;
import com.zch.monitor.AuditEventPublisher;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.time.Duration;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Test;
import org.springframework.boot.availability.ApplicationAvailabilityBean;
import org.springframework.boot.availability.AvailabilityChangeEvent;
import org.springframework.boot.availability.ReadinessState;
import org.springframework.mock.http.server.reactive.MockServerHttpRequest;
import org.springframework.mock.web.server.MockServerWebExchange;
import reactor.core.publisher.Mono;
import tools.jackson.databind.json.JsonMapper;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

public class TrafficLifecycleTest {
    public static TrafficLifecycle lifecycle(ApplicationAvailabilityBean availability) {
        return fixture(availability, 100).lifecycle;
    }
    private record Fixture(TrafficLifecycle lifecycle, AuditEventPublisher audit) { }
    private static Fixture fixture(ApplicationAvailabilityBean availability, long drainMs) {
        var runtime = new GatewayRuntimeProperties(); runtime.getAudit().setEnabled(false);
        var audit = new AuditEventPublisher(mock(AuditBatchWriter.class), JsonMapper.builder().build(), runtime, new SimpleMeterRegistry());
        var policy = new TrafficLifecycleProperties(); policy.setRequestDrainTimeoutMs(drainMs);
        var lifecycle = new TrafficLifecycle(policy, audit, availability, event -> {
            if (event instanceof AvailabilityChangeEvent<?> changed) availability.onApplicationEvent(changed);
        }, Duration.ofSeconds(30));
        lifecycle.start(); return new Fixture(lifecycle, audit);
    }
    private ApplicationAvailabilityBean ready() {
        var availability = new ApplicationAvailabilityBean();
        availability.onApplicationEvent(new AvailabilityChangeEvent<>(this, ReadinessState.ACCEPTING_TRAFFIC));
        return availability;
    }
    @Test void drainClosesAdmissionImmediatelyAndIsIdempotentWithoutExtendingDeadline() throws Exception {
        var availability = ready(); var f = fixture(availability, 1000); var lease = f.lifecycle.admit();
        var first = f.lifecycle.beginDrain();
        assertSame(first, f.lifecycle.beginDrain());
        assertEquals(ReadinessState.REFUSING_TRAFFIC, availability.getReadinessState());
        assertNull(f.lifecycle.admit());
        assertFalse(first.isDone()); assertEquals("requests", f.lifecycle.status().get("phase"));
        lease.complete(false, false); lease.complete(false, false);
        first.get(2, TimeUnit.SECONDS);
        assertEquals("drained", f.lifecycle.status().get("phase"));
        assertEquals(1L, f.lifecycle.status().get("completed"));
        assertEquals(0, f.lifecycle.status().get("activeBusinessRequests"));
        assertSame(first, f.lifecycle.beginDrain());
    }
    @Test void concurrentAdmissionAndDrainShareOneBoundary() throws Exception {
        var f = fixture(ready(), 1000); var start = new CountDownLatch(1);
        try (var pool = Executors.newFixedThreadPool(4)) {
            var work = new java.util.ArrayList<Future<?>>();
            for (int n = 0; n < 100; n++) work.add(pool.submit(() -> {
                start.await(); var lease = f.lifecycle.admit(); if (lease != null) lease.complete(false,false); return null;
            }));
            start.countDown(); f.lifecycle.beginDrain();
            for (var task : work) task.get(2,TimeUnit.SECONDS);
            f.lifecycle.beginDrain().get(2,TimeUnit.SECONDS);
            var state = f.lifecycle.status();
            assertEquals(100L, (long) state.get("admitted") + (long) state.get("rejectedBeforeAdmission"));
            assertEquals(state.get("admitted"),state.get("completed")); assertNull(f.lifecycle.admit());
        }
    }
    @Test void deadlineCancelsUpstreamAndReturns503BeforeCommit() throws Exception {
        var availability = ready(); var f = fixture(availability,100); var cancelled = new AtomicBoolean();
        var exchange = MockServerWebExchange.from(MockServerHttpRequest.get("/business"));
        var pending = new ReadinessFilter(availability,f.lifecycle).filter(exchange,
                e -> Mono.<Void>never().doOnCancel(() -> cancelled.set(true))).toFuture();
        f.lifecycle.beginDrain().get(2,TimeUnit.SECONDS); pending.get(1,TimeUnit.SECONDS);
        assertTrue(cancelled.get()); assertEquals(503,exchange.getResponse().getStatusCode().value());
        assertTrue(exchange.getResponse().getBodyAsString().block().contains("shutdown_deadline"));
        assertEquals(1L,f.lifecycle.status().get("deadlineTerminated"));
    }
    @Test void committedStreamTerminatesWithoutAppendingErrorJson() throws Exception {
        var availability = ready(); var f = fixture(availability,100); var exchange = MockServerWebExchange.from(MockServerHttpRequest.get("/stream"));
        var pending = new ReadinessFilter(availability,f.lifecycle).filter(exchange,
                e -> e.getResponse().writeWith(Mono.just(e.getResponse().bufferFactory().wrap("part".getBytes())))
                        .then(Mono.never())).toFuture();
        assertTrue(exchange.getResponse().isCommitted());
        f.lifecycle.beginDrain().get(2,TimeUnit.SECONDS);
        assertInstanceOf(ReadinessFilter.DrainDeadline.class,assertThrows(ExecutionException.class,() -> pending.get(1,TimeUnit.SECONDS)).getCause());
        assertEquals("part",exchange.getResponse().getBodyAsString().block());
        assertEquals(1L,f.lifecycle.status().get("deadlineTerminated"));
    }
    @Test void clientCancellationReleasesLeaseBeforeAuditStops() throws Exception {
        var availability = ready(); var f = fixture(availability,1000);
        var pending = new ReadinessFilter(availability,f.lifecycle).filter(
                MockServerWebExchange.from(MockServerHttpRequest.get("/business")), e -> Mono.never()).subscribe();
        pending.dispose(); f.lifecycle.beginDrain().get(2,TimeUnit.SECONDS);
        assertEquals(1L,f.lifecycle.status().get("clientCancelled"));
        assertEquals(0L,f.lifecycle.status().get("deadlineTerminated"));
        assertEquals("drained",f.lifecycle.status().get("phase"));
    }
    @Test void impossiblePhaseBudgetAndInvalidBudgetsRejectStartup() {
        var p = new TrafficLifecycleProperties(); p.setRequestDrainTimeoutMs(0);
        assertThrows(IllegalArgumentException.class,p::validate);
        p.setRequestDrainTimeoutMs(10000);
        assertThrows(IllegalArgumentException.class,() -> new TrafficLifecycle(p,mock(AuditEventPublisher.class),ready(),e -> {},Duration.ofSeconds(5)));
    }
}
