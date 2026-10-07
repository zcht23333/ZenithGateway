package com.zch.proxy;

import com.zch.monitor.RequestObservation;
import io.github.resilience4j.reactor.circuitbreaker.operator.CircuitBreakerOperator;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import org.springframework.cloud.gateway.filter.GatewayFilterChain;
import org.springframework.cloud.gateway.filter.GlobalFilter;
import org.springframework.cloud.gateway.route.Route;
import org.springframework.core.Ordered;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;
import static org.springframework.cloud.gateway.support.ServerWebExchangeUtils.GATEWAY_ROUTE_ATTR;

/** Outside NettyWriteResponseFilter (-1): admission and completion include the entire body. */
@Component
public class ProxyResilienceFilter implements GlobalFilter,Ordered {
    public static final String ENABLED="zenith.breaker.enabled",NAME="zenith.breaker.name";
    private final ProxyPolicy policy;
    private final ProxyBreakers breakers;
    public ProxyResilienceFilter(ProxyPolicy policy,ProxyBreakers breakers){this.policy=policy;this.breakers=breakers;}
    @Override public int getOrder(){return -100;}
    @Override public Mono<Void> filter(ServerWebExchange exchange,GatewayFilterChain chain){
        return Mono.deferContextual(context->{
            Route route=exchange.getRequiredAttribute(GATEWAY_ROUTE_ATTR);
            String scheme=route.getUri().getScheme();
            if(!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme))return chain.filter(exchange);
            var observation=context.<RequestObservation>getOrEmpty(RequestObservation.CONTEXT_KEY).orElseGet(RequestObservation::new);
            observation.routeId=route.getId();observation.phase="admission";
            var lifecycle=new ProxyResponseLifecycle(exchange.getResponse());
            var forwarded=exchange.mutate().response(lifecycle).build();
            // Defer subscription: an OPEN breaker must not allocate/send an upstream request.
            Mono<Integer> transfer=Mono.defer(()->chain.filter(forwarded))
                    .timeout(Duration.ofMillis(policy.getTotalTimeoutMs()),Mono.error(new ProxyFailure.TotalTimeout()))
                    .then(Mono.defer(()->lifecycle.bodyCancelled()
                            ? Mono.error(new ProxyFailure.ClientCancelled())
                            : Mono.just(exchange.getResponse().getStatusCode()==null?200:exchange.getResponse().getStatusCode().value())));
            if(Boolean.TRUE.equals(route.getMetadata().get(ENABLED)))
                transfer=transfer.transformDeferred(CircuitBreakerOperator.of(breakers.get((String)route.getMetadata().get(NAME))));
            breakers.active.incrementAndGet();
            return transfer.doOnNext(status->{if(status>=500)observation.reason="upstream_5xx";})
                    .then().onErrorResume(error->{
                        ProxyFailure failure=ProxyFailure.classify(error);observation.reason=failure.reason();
                        observation.failureType=error.getClass().getSimpleName();
                        if(error instanceof ProxyFailure.ClientCancelled)return Mono.empty();
                        // Once committed, propagate the error: Reactor Netty closes the response. Never append JSON.
                        if(exchange.getResponse().isCommitted())return Mono.error(error);
                        return failureResponse(exchange,failure,observation.phase);
                    }).doFinally(signal->breakers.active.decrementAndGet());
        });
    }
    static Mono<Void> failureResponse(ServerWebExchange exchange,ProxyFailure failure,String phase){
        var response=exchange.getResponse();response.setStatusCode(HttpStatusCode.valueOf(failure.status()));
        response.getHeaders().remove(HttpHeaders.CONTENT_LENGTH);response.getHeaders().remove(HttpHeaders.TRANSFER_ENCODING);
        response.getHeaders().remove(HttpHeaders.CONTENT_ENCODING);response.getHeaders().setContentType(MediaType.APPLICATION_JSON);
        response.getHeaders().setCacheControl("no-store");
        String body="{\"code\":"+failure.status()+",\"reason\":\""+failure.reason()+"\",\"phase\":\""+phase+"\",\"message\":\"Proxy request could not complete; upstream execution may have occurred\"}";
        byte[] bytes=body.getBytes(StandardCharsets.UTF_8);
        response.getHeaders().setContentLength(bytes.length);
        return response.writeWith(Mono.just(response.bufferFactory().wrap(bytes)));
    }
}
