package com.zch.monitor;

import java.util.concurrent.atomic.AtomicBoolean;

/** Shared through Reactor context, including internal forwards and error handling. */
public final class RequestObservation {
    public static final Object CONTEXT_KEY = RequestObservation.class;
    final long started = System.nanoTime();
    final AtomicBoolean recorded = new AtomicBoolean();
    volatile boolean proxied;
    public volatile boolean shutdownForced;
    public volatile com.zch.lifecycle.TrafficLifecycle.Lease admission;
    public volatile String routeId, reason, failureType;
    public volatile String rateLimitOutcome,rateLimitReason,rateLimitEvent,rateLimitAction,rateLimitExecution,rateLimitRejectionSource;
    public void limiter(com.zch.ratelimit.LimitDecision d){
        rateLimitOutcome=d.outcome();rateLimitReason=d.reason();rateLimitEvent=d.event();
        rateLimitAction=d.action();rateLimitExecution=d.execution();rateLimitRejectionSource=d.rejectionSource();
    }
    public volatile String phase="admission";
    public volatile int upstreamStatus;
    public void markProxied() { proxied = true; }
}
