package com.zch.filter;

import com.zch.monitor.RequestObservation;
import org.springframework.cloud.gateway.filter.GatewayFilterChain;
import org.springframework.cloud.gateway.filter.GlobalFilter;
import org.springframework.core.Ordered;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;

/** Marks gateway traffic; completion is recorded outside the exception handlers. */
@Component
public class AuditLogFilter implements GlobalFilter, Ordered {
    @Override
    public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
        return Mono.deferContextual(context -> {
            context.<RequestObservation>getOrEmpty(RequestObservation.CONTEXT_KEY)
                    .ifPresent(RequestObservation::markProxied);
            return chain.filter(exchange);
        });
    }

    @Override
    public int getOrder() { return -300; }
}
