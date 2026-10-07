package com.zch.monitor;

import com.zch.config.GatewayRuntimeProperties;
import com.zch.util.ClientIpResolver;
import org.springframework.http.server.reactive.HttpHandler;
import org.springframework.http.server.reactive.HttpHandlerDecoratorFactory;
import org.springframework.http.server.reactive.ServerHttpRequest;
import org.springframework.http.server.reactive.ServerHttpResponse;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Mono;
import reactor.core.publisher.SignalType;

/** The outer handler sees the final response after WebExceptionHandler/fallback handling. */
@Component
public class RequestCompletionRecorder implements HttpHandlerDecoratorFactory {
    private static final org.slf4j.Logger log=org.slf4j.LoggerFactory.getLogger(RequestCompletionRecorder.class);
    private final TrafficMetricsService metrics;
    private final GatewayMetrics gatewayMetrics;
    private final AuditEventPublisher audit;
    private final ClientIpResolver resolver;
    private final GatewayRuntimeProperties properties;

    public RequestCompletionRecorder(TrafficMetricsService metrics, AuditEventPublisher audit,
                                     ClientIpResolver resolver, GatewayRuntimeProperties properties, GatewayMetrics gatewayMetrics) {
        this.gatewayMetrics = gatewayMetrics;
        this.metrics = metrics;
        this.audit = audit;
        this.resolver = resolver;
        this.properties = properties;
    }

    @Override
    public HttpHandler apply(HttpHandler delegate) {
        return (request, response) -> Mono.defer(() -> {
            RequestObservation observation = new RequestObservation();
            return Mono.defer(() -> delegate.handle(request, response))
                    .doFinally(signal -> {
                        try { record(observation, request, response, signal); }
                        finally { if (observation.admission != null) observation.admission.complete(
                                signal == SignalType.CANCEL || "client_cancelled".equals(observation.reason), observation.shutdownForced); }
                    })
                    .contextWrite(context -> context.put(RequestObservation.CONTEXT_KEY, observation));
        });
    }

    private void record(RequestObservation observation, ServerHttpRequest request,
                        ServerHttpResponse response, SignalType signal) {
        if (!observation.proxied || !observation.recorded.compareAndSet(false, true)) return;
        // An outer CANCEL is the actual terminal result, even after a deadline selected its fallback.
        // Only an inner cancellation reason can be suppressed: the deadline itself cancels the source.
        boolean cancelled = signal == SignalType.CANCEL
                || (!observation.shutdownForced && "client_cancelled".equals(observation.reason));
        boolean complete = signal == SignalType.ON_COMPLETE && !cancelled;
        int status = response.isCommitted() || complete
                ? response.getStatusCode() == null ? 200 : response.getStatusCode().value() : 0;
        String outcome = cancelled ? "cancelled"
                : signal == SignalType.ON_ERROR ? "error" : status >= 500 ? "http_error" : "completed";
        String reason=observation.shutdownForced?"shutdown_deadline":cancelled?"client_cancelled":observation.reason==null?"none":observation.reason;
        long elapsed = Math.max(0, System.nanoTime() - observation.started);
        gatewayMetrics.proxyOutcome(reason);
        if (!"none".equals(reason)) log.info("Proxy completed route={} reason={} phase={} status={} outcome={} durationMs={} error={}",
                observation.routeId,reason,observation.phase,status,outcome,elapsed/1_000_000,observation.failureType);
        gatewayMetrics.request(status, outcome, elapsed);
        TrafficData event = new TrafficData();
        event.setTimestamp(System.currentTimeMillis());
        event.setMethod(request.getMethod().name());
        event.setPath(request.getURI().getRawPath());
        event.setStatusCode(status);
        event.setDurationMs(elapsed / 1_000_000);
        event.setClientIp(resolver.resolve(request));
        event.setOutcome(outcome);
        event.setReason(reason); event.setPhase(observation.phase);
        event.setRateLimitOutcome(observation.rateLimitOutcome);event.setRateLimitReason(observation.rateLimitReason);
        event.setRateLimitEvent(observation.rateLimitEvent);event.setRateLimitAction(observation.rateLimitAction);event.setRateLimitExecution(observation.rateLimitExecution);event.setRateLimitRejectionSource(observation.rateLimitRejectionSource);
        metrics.accept(event);
        if (properties.getAudit().isEnabled()) audit.publish(event);
    }
}
