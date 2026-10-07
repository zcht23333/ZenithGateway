package com.zch.lifecycle;

import com.zch.config.GatewayRuntimeProperties;
import com.zch.filter.ReadinessFilter;
import com.zch.monitor.*;
import com.zch.util.ClientIpResolver;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.time.Duration;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.parallel.Isolated;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;
import org.junit.jupiter.params.provider.ValueSource;
import org.mockito.ArgumentCaptor;
import org.reactivestreams.Subscription;
import org.springframework.boot.availability.*;
import org.springframework.http.server.reactive.HttpHandler;
import org.springframework.http.server.reactive.ServerHttpResponse;
import org.springframework.http.server.reactive.ServerHttpResponseDecorator;
import org.springframework.mock.http.server.reactive.MockServerHttpRequest;
import org.springframework.mock.web.server.MockServerWebExchange;
import reactor.core.CoreSubscriber;
import reactor.core.Disposable;
import reactor.core.publisher.*;
import reactor.util.context.Context;
import tools.jackson.databind.json.JsonMapper;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/** Pause before deadline arbitration or fallback completion, never at a guessed wall-clock offset. */
@Isolated("Installs a scoped Reactor hook while subscribing one request")
class DrainTerminalRaceTest {
    private static final String HOOK = "zenith-drain-terminal-race";
    enum Winner { NORMAL, CANCEL, COMMITTED_CANCEL, ERROR }

    @ParameterizedTest
    @EnumSource(Winner.class)
    void lateDeadlineCannotChangeTheWinnerOrRecordTwice(Winner winner) throws Exception {
        var gate = new DeadlineGate();
        try (var f = new Fixture(winner == Winner.COMMITTED_CANCEL)) {
            gate.install();
            try { f.subscribe(); } finally { Hooks.resetOnEachOperator(HOOK); }
            var drained = f.lifecycle.beginDrain();
            try {
                assertTrue(gate.entered.await(3, TimeUnit.SECONDS), "Deadline did not reach the arbitration barrier");
                switch (winner) {
                    case NORMAL -> f.business.tryEmitEmpty();
                    case CANCEL, COMMITTED_CANCEL -> f.pending.dispose();
                    case ERROR -> f.business.tryEmitError(new IllegalStateException("upstream failed first"));
                }
                f.assertWinner(winner); // The deadline is still blocked: completion/cancel/error has actually finished.
            } finally { gate.release.countDown(); }
            drained.get(5, TimeUnit.SECONDS);
            assertNull(gate.failure.get());
            f.assertWinner(winner); // A late deadline must not alter the audit, metrics or lease counters.
            assertEquals("drained", f.lifecycle.status().get("phase"));
        } finally {
            gate.release.countDown();
            Hooks.resetOnEachOperator(HOOK);
        }
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void winningDeadlineStillTerminatesAndRecordsExactlyOnce(boolean committed) throws Exception {
        try (var f = new Fixture(committed)) {
            f.subscribe();
            f.lifecycle.beginDrain().get(5, TimeUnit.SECONDS);
            assertTrue(f.upstreamCancelled.get());
            var event = f.recorded();
            assertEquals("shutdown_deadline", event.getReason());
            assertEquals(committed ? 200 : 503, event.getStatusCode());
            assertEquals(committed ? "error" : "http_error", event.getOutcome());
            assertEquals(1L, f.lifecycle.status().get("deadlineTerminated"));
            assertEquals(0L, f.lifecycle.status().get("clientCancelled"));
            assertEquals(0, f.lifecycle.status().get("activeBusinessRequests"));
            if (committed) {
                assertInstanceOf(ReadinessFilter.DrainDeadline.class, f.error.get());
                assertEquals("prefix", f.exchange.getResponse().getBodyAsString().block());
            } else {
                assertNull(f.error.get());
                assertTrue(f.exchange.getResponse().getBodyAsString().block().contains("shutdown_deadline"));
            }
            f.business.tryEmitEmpty();
            assertSame(event, f.recorded());
            assertEquals(1L, f.lifecycle.status().get("completed"));
            assertEquals(1L, f.audit.status().persisted());
        }
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void cancellationAfterDeadlineWinsKeepsActualTerminalOutcome(boolean committed) throws Exception {
        var gate = new FallbackGate();
        try (var f = new Fixture(committed, gate)) {
            f.subscribe();
            var drained = f.lifecycle.beginDrain();
            TrafficData event;
            try {
                assertTrue(gate.entered.await(3, TimeUnit.SECONDS), "Timeout fallback was not selected");
                assertTrue(f.observation.get().shutdownForced);
                assertEquals(committed, f.response.isCommitted(), "Preserve actual response state at cancellation");
                assertTrue(f.upstreamCancelled.get(), "Deadline must already have cancelled the business source");
                f.pending.dispose(); // Actual outer CANCEL while the selected fallback has not finished.
                event = f.recorded();
                assertEquals("cancelled", event.getOutcome());
                assertEquals(committed ? 200 : 0, event.getStatusCode());
                assertEquals("shutdown_deadline", event.getReason());
                assertEquals(1, f.registry.get("zenith.gateway.requests").tags("outcome", "cancelled", "status", committed ? "2xx" : "none").timer().count());
                assertEquals(1, f.registry.get("zenith.gateway.proxy.outcomes").tag("reason", "shutdown_deadline").counter().count());
                assertEquals(0, f.lifecycle.status().get("activeBusinessRequests"));
            } finally { gate.release.countDown(); }
            drained.get(5, TimeUnit.SECONDS);
            assertNull(gate.failure.get());
            f.business.tryEmitEmpty();
            assertSame(event, f.recorded(), "Late fallback/source signals must not record another terminal event");
            assertEquals("cancelled", event.getOutcome());
            assertEquals(committed ? 200 : 0, event.getStatusCode());
            // The cause remains the deadline; the HTTP outcome independently records client cancellation.
            assertEquals(1L, f.lifecycle.status().get("deadlineTerminated"));
            assertEquals(0L, f.lifecycle.status().get("clientCancelled"));
            assertEquals(1L, f.lifecycle.status().get("completed"));
            assertEquals(1L, f.audit.status().persisted());
            assertEquals("drained", f.lifecycle.status().get("phase"));
            if (committed) assertEquals("prefix", f.exchange.getResponse().getBodyAsString().block());
        } finally { gate.release.countDown(); }
    }

    private static final class Fixture implements AutoCloseable {
        final SimpleMeterRegistry registry = new SimpleMeterRegistry();
        final GatewayRuntimeProperties runtime = new GatewayRuntimeProperties();
        final AuditEventPublisher audit = spy(new AuditEventPublisher(mock(AuditBatchWriter.class),
                JsonMapper.builder().build(), runtime, registry));
        final ApplicationAvailabilityBean availability = new ApplicationAvailabilityBean();
        final TrafficMetricsService metrics = new TrafficMetricsService(runtime, registry, true);
        final Sinks.Empty<Void> business = Sinks.empty();
        final MockServerWebExchange exchange = MockServerWebExchange.from(MockServerHttpRequest.get("/business"));
        final ServerHttpResponse response;
        final AtomicReference<RequestObservation> observation = new AtomicReference<>();
        final AtomicBoolean upstreamCancelled = new AtomicBoolean();
        final AtomicReference<Throwable> error = new AtomicReference<>();
        final TrafficLifecycle lifecycle;
        final HttpHandler handler;
        Disposable pending;

        Fixture(boolean committed) { this(committed, null); }

        Fixture(boolean committed, FallbackGate gate) {
            response = gate == null ? exchange.getResponse() : gate.wrap(exchange.getResponse(), observation);
            var routedExchange = exchange.mutate().response(response).build();
            availability.onApplicationEvent(new AvailabilityChangeEvent<>(this, ReadinessState.ACCEPTING_TRAFFIC));
            var policy = new TrafficLifecycleProperties(); policy.setRequestDrainTimeoutMs(100);
            lifecycle = new TrafficLifecycle(policy, audit, availability, event -> {
                if (event instanceof AvailabilityChangeEvent<?> changed) availability.onApplicationEvent(changed);
            }, Duration.ofSeconds(30));
            audit.start(); lifecycle.start();
            var resolver = mock(ClientIpResolver.class); when(resolver.resolve(any())).thenReturn("192.0.2.1");
            var recorder = new RequestCompletionRecorder(metrics, audit, resolver, runtime,
                    new GatewayMetrics(registry, true, availability));
            var filter = new ReadinessFilter(availability, lifecycle);
            HttpHandler delegate = (request, response) -> filter.filter(routedExchange, e -> Mono.deferContextual(context -> {
                var current = context.<RequestObservation>get(RequestObservation.CONTEXT_KEY);
                observation.set(current); current.markProxied();
                var source = business.asMono().doOnCancel(() -> {
                    upstreamCancelled.set(true);
                    // An inner body cancellation can be reported even when the outer deadline caused it.
                    // The uncancelled fallback controls must still record 503/http_error or 200/error.
                    current.reason = "client_cancelled";
                });
                return committed
                        ? e.getResponse().writeWith(Mono.just(e.getResponse().bufferFactory().wrap("prefix".getBytes())))
                                .then(source)
                        : source.then(Mono.defer(e.getResponse()::setComplete));
            }));
            handler = recorder.apply(delegate);
        }
        void subscribe() { pending = handler.handle(exchange.getRequest(), response).subscribe(v -> {}, error::set); }
        TrafficData recorded() {
            var capture = ArgumentCaptor.forClass(TrafficData.class);
            verify(audit, times(1)).publish(capture.capture());
            assertEquals(1, metrics.latestSnapshot().getCompletedTotal());
            assertEquals(1, registry.find("zenith.gateway.requests").timers().stream().mapToLong(t -> t.count()).sum());
            return capture.getValue();
        }
        void assertWinner(Winner winner) {
            var event = recorded();
            boolean cancelled = winner == Winner.CANCEL || winner == Winner.COMMITTED_CANCEL;
            assertEquals(cancelled ? "client_cancelled" : "none", event.getReason());
            assertEquals(cancelled ? "cancelled" : winner == Winner.ERROR ? "error" : "completed", event.getOutcome());
            assertEquals(winner == Winner.NORMAL || winner == Winner.COMMITTED_CANCEL ? 200 : 0, event.getStatusCode());
            assertEquals(0L, lifecycle.status().get("deadlineTerminated"));
            assertEquals(cancelled ? 1L : 0L, lifecycle.status().get("clientCancelled"));
            assertEquals(1L, lifecycle.status().get("completed"));
            assertEquals(0, lifecycle.status().get("activeBusinessRequests"));
            assertEquals(0, registry.get("zenith.gateway.proxy.outcomes").tag("reason", "shutdown_deadline").counter().count());
        }
        @Override public void close() throws Exception {
            if (pending != null) pending.dispose();
            lifecycle.beginDrain().get(5, TimeUnit.SECONDS);
            registry.close();
        }
    }

    private static final class FallbackGate {
        final CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        final AtomicBoolean paused = new AtomicBoolean();
        final AtomicReference<Throwable> failure = new AtomicReference<>();
        ServerHttpResponse wrap(ServerHttpResponse response, AtomicReference<RequestObservation> observation) {
            return new ServerHttpResponseDecorator(response) {
                @Override public boolean isCommitted() {
                    var current = observation.get();
                    if (current != null && current.shutdownForced && paused.compareAndSet(false, true)) {
                        entered.countDown();
                        try {
                            if (!release.await(5, TimeUnit.SECONDS)) throw new AssertionError("Fallback barrier timed out");
                        } catch (Throwable interrupted) { failure.set(interrupted); }
                    }
                    return super.isCommitted(); // No fabricated commitment or terminal signal.
                }
            };
        }
    }

    private static final class DeadlineGate {
        final CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        final AtomicReference<Throwable> failure = new AtomicReference<>();
        void install() {
            Hooks.onEachOperator(HOOK, Operators.<Object, Object>lift((operator, actual) -> {
                // Pinned reactor-core 3.8.7. Fail visibly if a dependency upgrade moves this seam.
                if (!actual.getClass().getName().equals("reactor.core.publisher.FluxTimeout$TimeoutTimeoutSubscriber")) return actual;
                return new CoreSubscriber<Object>() {
                    @Override public Context currentContext() { return actual.currentContext(); }
                    @Override public void onSubscribe(Subscription s) { actual.onSubscribe(s); }
                    @Override public void onNext(Object o) { actual.onNext(o); }
                    @Override public void onError(Throwable e) { actual.onError(e); }
                    @Override public void onComplete() {
                        entered.countDown();
                        try {
                            if (!release.await(5, TimeUnit.SECONDS)) throw new AssertionError("Deadline barrier timed out");
                        } catch (Throwable interrupted) { failure.set(interrupted); }
                        actual.onComplete();
                    }
                };
            }));
        }
    }
}
