package com.zch.filter;

import com.zch.lifecycle.TrafficLifecycle;
import com.zch.monitor.RequestObservation;
import java.nio.charset.StandardCharsets;
import java.util.Set;
import org.springframework.boot.availability.ApplicationAvailability;
import org.springframework.boot.availability.ReadinessState;
import org.springframework.core.Ordered;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.WebFilter;
import org.springframework.web.server.WebFilterChain;
import org.springframework.web.util.pattern.PathPattern;
import org.springframework.web.util.pattern.PathPatternParser;
import reactor.core.publisher.Mono;
import reactor.core.publisher.SignalType;

/** Bound port != restored state; restored state != proven load capacity. */
@Component
public class ReadinessFilter implements WebFilter, Ordered {
    private static final PathPattern ACTUATOR = PathPatternParser.defaultInstance.parse("/actuator/**");
    private static final Set<String> DRAIN_READS = Set.of("/settings/lifecycle", "/settings/runtime/adopted",
            "/settings/runtime/sync", "/settings/routes/adopted", "/settings/routes/diagnostics",
            "/settings/proxy/diagnostics", "/settings/rate-limit/diagnostics", "/monitor/audit/status");
    private final ApplicationAvailability availability;
    private final TrafficLifecycle lifecycle;
    public ReadinessFilter(ApplicationAvailability availability, TrafficLifecycle lifecycle) {
        this.availability = availability; this.lifecycle = lifecycle;
    }
    @Override public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) {
        var path = exchange.getRequest().getPath().pathWithinApplication();
        String value = path.value(), method = exchange.getRequest().getMethod().name();
        if (ACTUATOR.matches(path)) return chain.filter(exchange);
        boolean control = value.startsWith("/settings/") || value.startsWith("/monitor/") || value.startsWith("/dashboard/");
        if (lifecycle.isDraining() && control) {
            if (("GET".equals(method) && DRAIN_READS.contains(value))
                    || ("POST".equals(method) && value.equals("/settings/lifecycle/drain"))) return chain.filter(exchange);
            return refuse(exchange, "instance_draining");
        }
        if (!lifecycle.isDraining() && availability.getReadinessState() != ReadinessState.ACCEPTING_TRAFFIC)
            return refuse(exchange, "instance_not_ready");
        if (control) return chain.filter(exchange);
        return Mono.deferContextual(context -> {
            var lease = lifecycle.admit();
            if (lease == null) return refuse(exchange, "instance_draining");
            boolean outer = context.hasKey(RequestObservation.CONTEXT_KEY);
            var observation = context.<RequestObservation>getOrEmpty(RequestObservation.CONTEXT_KEY).orElseGet(RequestObservation::new);
            observation.admission = lease;
            return Mono.defer(() -> chain.filter(exchange))
                    .timeout(Mono.defer(lifecycle::deadline), Mono.defer(() -> {
                        // Subscribed only after timeout wins Reactor's arbitration against the source/cancel.
                        // A deadline notification alone must not overwrite the actual terminal outcome.
                        observation.shutdownForced = true;
                        return exchange.getResponse().isCommitted()
                                ? Mono.error(new DrainDeadline())
                                : refuse(exchange, "shutdown_deadline");
                    }))
                    .doFinally(signal -> {
                        // Standalone filter tests lack the outer final-response recorder.
                        if (!outer) lease.complete(signal == SignalType.CANCEL, observation.shutdownForced);
                    });
        });
    }
    private Mono<Void> refuse(ServerWebExchange exchange, String reason) {
        var response = exchange.getResponse();
        response.setStatusCode(HttpStatus.SERVICE_UNAVAILABLE);
        response.getHeaders().setCacheControl("no-store");
        response.getHeaders().set(HttpHeaders.CONNECTION, "close");
        if ("instance_not_ready".equals(reason)) response.getHeaders().set("Retry-After", "1");
        response.getHeaders().remove(HttpHeaders.CONTENT_LENGTH); response.getHeaders().remove(HttpHeaders.TRANSFER_ENCODING);
        response.getHeaders().remove(HttpHeaders.CONTENT_ENCODING); response.getHeaders().setContentType(MediaType.APPLICATION_JSON);
        byte[] bytes = ("{\"code\":503,\"reason\":\"" + reason + "\"}").getBytes(StandardCharsets.UTF_8);
        return response.writeWith(Mono.just(response.bufferFactory().wrap(bytes)));
    }
    public static final class DrainDeadline extends RuntimeException {
        public DrainDeadline() { super("Business request exceeded shutdown drain budget; upstream execution may have occurred"); }
    }
    // Management authentication always precedes admission and remains in force during drain.
    @Override public int getOrder() { return -90; }
}
