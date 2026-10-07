package com.zch.lifecycle;

import com.zch.monitor.AuditEventPublisher;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.availability.ApplicationAvailability;
import org.springframework.boot.availability.AvailabilityChangeEvent;
import org.springframework.boot.availability.ReadinessState;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.context.SmartLifecycle;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Mono;
import reactor.core.publisher.Sinks;

/** One irreversible drain per JVM. Admission and drain share the same lock. */
@Component
public class TrafficLifecycle implements SmartLifecycle {
    private final Object lock = new Object();
    private final TrafficLifecycleProperties options;
    private final AuditEventPublisher audit;
    private final ApplicationAvailability availability;
    private final ApplicationEventPublisher events;
    private final Sinks.Empty<Void> deadline = Sinks.empty();
    private final CompletableFuture<Void> finished = new CompletableFuture<>();
    private volatile boolean draining, running;
    private String phase = "serving";
    private Instant drainStartedAt, requestsFinishedAt, auditFinishedAt;
    private long admitted, completed, rejected, cancelled, forced, drainStartedNanos;
    private int active;
    private final long budgetMs;

    public TrafficLifecycle(TrafficLifecycleProperties options, AuditEventPublisher audit,
            ApplicationAvailability availability, ApplicationEventPublisher events,
            @Value("${spring.lifecycle.timeout-per-shutdown-phase:30s}") Duration phaseBudget) {
        options.validate();
        this.options = options; this.audit = audit; this.availability = availability; this.events = events;
        budgetMs = options.getRequestDrainTimeoutMs() + options.getCancellationSettleTimeoutMs() + audit.shutdownBudgetMs();
        if (phaseBudget.toMillis() < budgetMs + 500)
            throw new IllegalArgumentException("spring.lifecycle.timeout-per-shutdown-phase must cover traffic + cancellation + audit drain budgets and 500 ms margin");
    }
    public Lease admit() {
        synchronized (lock) {
            if (draining || availability.getReadinessState() != ReadinessState.ACCEPTING_TRAFFIC) {
                rejected++; return null;
            }
            active++; admitted++; return new Lease();
        }
    }
    public boolean isDraining() { return draining; }
    public Mono<Void> deadline() { return deadline.asMono(); }
    public CompletableFuture<Void> beginDrain() {
        synchronized (lock) {
            if (draining) return finished;
            draining = true; phase = "requests"; drainStartedAt = Instant.now(); drainStartedNanos = System.nanoTime();
        }
        AvailabilityChangeEvent.publish(events, this, ReadinessState.REFUSING_TRAFFIC);
        LoggerFactory.getLogger(getClass()).info("Traffic drain started; new business admission closed");
        // One owned coordinator, no executor queue, no blocking on the event loop.
        Thread.ofVirtual().name("zenith-traffic-drain").start(this::drain);
        return finished;
    }
    private void drain() {
        try {
            if (!awaitEmptyUntil(drainStartedNanos + TimeUnit.MILLISECONDS.toNanos(options.getRequestDrainTimeoutMs()))) {
                synchronized (lock) { phase = "cancelling"; }
                deadline.tryEmitEmpty(); // Cancels only admitted requests that have not completed.
                awaitEmptyUntil(System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(options.getCancellationSettleTimeoutMs()));
            }
            synchronized (lock) { requestsFinishedAt = Instant.now(); phase = "audit"; }
            audit.stop(); // Completion recording precedes lease release, so the queue is now closed safely.
            synchronized (lock) {
                auditFinishedAt = Instant.now();
                phase = active == 0 && audit.status().pending() == 0 && !audit.isRunning() ? "drained" : "incomplete";
            }
        } catch (Throwable failure) {
            synchronized (lock) { phase = "incomplete"; }
            LoggerFactory.getLogger(getClass()).error("Traffic drain failed within shutdown workflow", failure);
        } finally {
            LoggerFactory.getLogger(getClass()).info("Traffic drain finished: {}", status());
            finished.complete(null);
        }
    }
    private boolean awaitEmptyUntil(long end) throws InterruptedException {
        synchronized (lock) {
            long left;
            while (active > 0 && (left = end - System.nanoTime()) > 0) TimeUnit.NANOSECONDS.timedWait(lock, left);
            return active == 0;
        }
    }
    public Map<String, Object> status() {
        synchronized (lock) {
            var result = new LinkedHashMap<String, Object>();
            result.put("source", "local"); result.put("draining", draining);
            result.put("phase", draining ? phase : availability.getReadinessState() == ReadinessState.ACCEPTING_TRAFFIC ? "ready" : "starting");
            result.put("activeBusinessRequests", active); result.put("admitted", admitted); result.put("completed", completed);
            result.put("rejectedBeforeAdmission", rejected); result.put("clientCancelled", cancelled); result.put("deadlineTerminated", forced);
            result.put("drainElapsedMs", draining ? TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - drainStartedNanos) : null);
            result.put("drainStartedAt", drainStartedAt); result.put("requestsFinishedAt", requestsFinishedAt); result.put("auditFinishedAt", auditFinishedAt);
            result.put("requestDrainTimeoutMs", options.getRequestDrainTimeoutMs());
            result.put("cancellationSettleTimeoutMs", options.getCancellationSettleTimeoutMs());
            result.put("auditStopBudgetMs", audit.shutdownBudgetMs()); result.put("coordinatorBudgetMs", budgetMs);
            result.put("audit", audit.status());
            return result;
        }
    }
    public final class Lease {
        private final AtomicBoolean released = new AtomicBoolean();
        public void complete(boolean clientCancelled, boolean deadlineTerminated) {
            if (!released.compareAndSet(false, true)) return;
            synchronized (lock) {
                active--; completed++;
                if (deadlineTerminated) forced++; else if (clientCancelled) cancelled++;
                lock.notifyAll();
            }
        }
    }
    @Override public void start() { running = true; }
    @Override public boolean isRunning() { return running; }
    // Boot 4.1.1 HTTP graceful phase = MAX_VALUE - 1024; audit phase = 0.
    @Override public int getPhase() { return Integer.MAX_VALUE; }
    @Override public boolean isPauseable() { return false; }
    @Override public void stop(Runnable callback) { beginDrain().whenComplete((ok, error) -> { running = false; callback.run(); }); }
    @Override public void stop() {
        try { beginDrain().get(budgetMs + 500, TimeUnit.MILLISECONDS); }
        catch (Exception failure) { LoggerFactory.getLogger(getClass()).warn("Traffic drain coordinator budget exhausted", failure); }
        finally { running = false; }
    }
}
