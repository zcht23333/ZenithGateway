package com.zch.filter;

import com.zch.config.GatewayRuntimeProperties;
import com.zch.monitor.GatewayMetrics;
import com.zch.monitor.RequestObservation;
import com.zch.ratelimit.LimitDecision;
import com.zch.ratelimit.RateLimitDecider;
import com.zch.util.ClientIpResolver;
import java.nio.charset.StandardCharsets;
import org.springframework.cloud.gateway.filter.GatewayFilterChain;
import org.springframework.cloud.gateway.filter.GlobalFilter;
import org.springframework.core.Ordered;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;
import reactor.core.publisher.SignalType;

@Component
public class RateLimitFilter implements GlobalFilter,Ordered {
    private final RateLimitDecider limiter;
    private final GatewayRuntimeProperties properties;
    private final ClientIpResolver resolver;
    private final GatewayMetrics metrics;
    public RateLimitFilter(RateLimitDecider limiter,GatewayRuntimeProperties properties,ClientIpResolver resolver,GatewayMetrics metrics){
        this.limiter=limiter;this.properties=properties;this.resolver=resolver;this.metrics=metrics;
    }
    @Override public int getOrder(){return -200;}
    @Override public Mono<Void> filter(ServerWebExchange exchange,GatewayFilterChain chain){
        return Mono.deferContextual(context->{
            var snapshot=properties.snapshot(); // One whole versioned snapshot; never query Redis runtime configuration.
            var observation=context.<RequestObservation>getOrEmpty(RequestObservation.CONTEXT_KEY).orElseGet(RequestObservation::new);
            observation.phase="rate_limit";
            long start=System.nanoTime();
            var measured=new java.util.concurrent.atomic.AtomicBoolean();
            Runnable measure=()->{
                if(!measured.compareAndSet(false,true)||!snapshot.rateLimit().enabled())return;
                int result=switch(String.valueOf(observation.rateLimitOutcome)){
                    case "allowed" -> 0;
                    case "limited","unfulfillable" -> 1;
                    case "cancelled" -> 3;
                    default -> 2;
                };
                metrics.redis(result,System.nanoTime()-start);
            };
            return limiter.decide(snapshot,resolver.resolve(exchange.getRequest()))
                    .doOnNext(d->{
                        observation.limiter(d);measure.run();
                    })
                    .doFinally(signal->{
                        if(signal==SignalType.CANCEL&&observation.rateLimitOutcome==null){observation.rateLimitOutcome="cancelled";observation.rateLimitReason="client_cancelled";}
                        measure.run();
                    })
                    .flatMap(d->{
                        if(d.forwards())return chain.filter(exchange);
                        observation.reason=rejectionReason(d);
                        return reject(exchange,d);
                    });
        });
    }
    private static String rejectionReason(LimitDecision d){
        return switch(d.event()){
            case "local_unavailable" -> "limiter_local_unavailable";
            case "redis_unconfirmed" -> "limiter_redis_unconfirmed";
            default -> "gateway_limited";
        };
    }
    private Mono<Void> reject(ServerWebExchange exchange,LimitDecision decision){
        boolean quota=decision.outcome().equals("limited")||decision.outcome().equals("unfulfillable");
        var status=quota?HttpStatus.TOO_MANY_REQUESTS:HttpStatus.SERVICE_UNAVAILABLE;
        var response=exchange.getResponse();response.setStatusCode(status);
        response.getHeaders().setContentType(MediaType.APPLICATION_JSON);response.getHeaders().setCacheControl("no-store");
        if(quota&&decision.retryAfterSeconds()!=null)response.getHeaders().set("Retry-After",decision.retryAfterSeconds().toString());
        // All strings below are fixed server vocabulary, never client identifiers.
        String message=quota?(decision.outcome().equals("unfulfillable")?"Request cost exceeds bucket capacity":"Too many requests")
                :decision.event().equals("local_unavailable")?"Rate limiter local resources unavailable":"Rate limiter could not confirm quota";
        String text="{\"code\":"+status.value()+",\"reason\":\""+rejectionReason(decision)+"\",\"limitReason\":\""+decision.reason()
                +"\",\"limitEvent\":\""+decision.event()+"\",\"limitAction\":\""+decision.action()+"\",\"limitExecution\":\""+decision.execution()
                +"\",\"limitRejectionSource\":"+(decision.rejectionSource()==null?"null":"\""+decision.rejectionSource()+"\"")
                +",\"message\":\""+message+"\",\"retryAfterSeconds\":"+decision.retryAfterSeconds()+"}";
        return response.writeWith(Mono.just(response.bufferFactory().wrap(text.getBytes(StandardCharsets.UTF_8))));
    }
}
