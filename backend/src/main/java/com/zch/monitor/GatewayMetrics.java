package com.zch.monitor;

import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import java.time.Duration;
import java.util.concurrent.TimeUnit;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.availability.ApplicationAvailability;
import org.springframework.boot.availability.ReadinessState;
import org.springframework.stereotype.Component;

/** Fixed label sets and pre-registered meters keep request paths and client identities out of metrics. */
@Component
public class GatewayMetrics {
    private static final String[] STATUSES = {"none", "1xx", "2xx", "3xx", "4xx", "5xx", "other"};
    private static final String[] OUTCOMES = {"completed", "http_error", "error", "cancelled"};
    private static final Duration[] REQUEST_BUCKETS = {
        Duration.ofMillis(5), Duration.ofMillis(10), Duration.ofMillis(25), Duration.ofMillis(50),
        Duration.ofMillis(100), Duration.ofMillis(250), Duration.ofMillis(500),
        Duration.ofSeconds(1), Duration.ofSeconds(2), Duration.ofSeconds(5), Duration.ofSeconds(10)
    };
    private static final String[] REASONS={"none","client_cancelled","gateway_limited","limiter_local_unavailable","limiter_redis_unconfirmed","upstream_5xx","circuit_open",
            "proxy_total_timeout","upstream_connect_timeout","upstream_read_idle","upstream_tls_timeout",
            "proxy_pool_timeout","proxy_pool_full","upstream_headers_timeout","upstream_connect_error","upstream_disconnect",
            "upstream_tls_error","proxy_internal_error","shutdown_deadline"};
    private final java.util.Map<String,io.micrometer.core.instrument.Counter> reasons=new java.util.HashMap<>();
    private final java.util.Map<String,io.micrometer.core.instrument.Counter> limiterDecisions=new java.util.HashMap<>();
    private final boolean enabled;
    private final Timer[][] requests = new Timer[STATUSES.length][OUTCOMES.length];
    private final Timer[] redis = new Timer[4];

    public GatewayMetrics(MeterRegistry registry, @Value("${zenith.observability.enabled:true}") boolean enabled,
                          ApplicationAvailability availability) {
        this.enabled = enabled;
        Gauge.builder("zenith.gateway.ready", availability,
                a -> a.getReadinessState() == ReadinessState.ACCEPTING_TRAFFIC ? 1 : 0).register(registry);
        if (!enabled) return;
        for(String outcome:new String[]{"disabled","allowed","limited","unfulfillable","redis_fail_open","local_fail_open","redis_rejected","local_rejected","cancelled"}){
            var d=com.zch.ratelimit.LimitDecision.local(outcome,"fixed","not_sent");
            for(String execution:new String[]{"not_sent","not_written","confirmed","unknown"})
                limiterDecisions.put(outcome+":"+execution,registry.counter("zenith.ratelimit.decisions","event",d.event(),"action",d.action(),"execution",execution));
        }
        for(String reason:REASONS)reasons.put(reason,registry.counter("zenith.gateway.proxy.outcomes","reason",reason));
        for (int s = 0; s < STATUSES.length; s++) {
            for (int o = 0; o < OUTCOMES.length; o++) {
                requests[s][o] = Timer.builder("zenith.gateway.requests")
                        .tags("status", STATUSES[s], "outcome", OUTCOMES[o])
                        .serviceLevelObjectives(REQUEST_BUCKETS).register(registry);
            }
        }
        String[] results = {"allowed", "limited", "error", "cancelled"};
        for (int i = 0; i < results.length; i++) {
            redis[i] = Timer.builder("zenith.ratelimit.redis").tag("outcome", results[i])
                    .serviceLevelObjectives(Duration.ofMillis(5), Duration.ofMillis(20),
                            Duration.ofMillis(50), Duration.ofMillis(100), Duration.ofMillis(250),
                            Duration.ofMillis(500), Duration.ofSeconds(1)).register(registry);
        }
    }

    public void request(int status, String outcome, long elapsedNanos) {
        if (!enabled) return;
        int statusIndex = status == 0 ? 0 : status >= 100 && status < 600 ? status / 100 : 6;
        int outcomeIndex = switch (outcome) {
            case "completed" -> 0;
            case "http_error" -> 1;
            case "cancelled" -> 3;
            default -> 2;
        };
        requests[statusIndex][outcomeIndex].record(Math.max(0, elapsedNanos), TimeUnit.NANOSECONDS);
    }

    public void proxyOutcome(String reason) {
        if(enabled)reasons.getOrDefault(reason,reasons.get("proxy_internal_error")).increment();
    }

    public void limiterDecision(com.zch.ratelimit.LimitDecision decision){
        if(enabled){var counter=limiterDecisions.get(decision.outcome()+":"+decision.execution());if(counter!=null)counter.increment();}
    }
    public void redis(int result, long elapsedNanos) {
        if (enabled) redis[result].record(Math.max(0, elapsedNanos), TimeUnit.NANOSECONDS);
    }
}
