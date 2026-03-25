package com.zch.filter;

import com.zch.monitor.AuditEventPublisher;
import com.zch.monitor.TrafficData;
import com.zch.util.ClientIpResolver;
import org.springframework.cloud.gateway.filter.GatewayFilterChain;
import org.springframework.cloud.gateway.filter.GlobalFilter;
import org.springframework.core.Ordered;
import org.springframework.http.HttpStatusCode;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;

@Component
public class AuditLogFilter implements GlobalFilter, Ordered {

    private final AuditEventPublisher auditEventPublisher;

    public AuditLogFilter(AuditEventPublisher auditEventPublisher) {
        this.auditEventPublisher = auditEventPublisher;
    }

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
        long start = System.currentTimeMillis();

        return chain.filter(exchange)
                .doFinally(signalType -> {
                    HttpStatusCode status = exchange.getResponse().getStatusCode();
                    int statusCode = status == null ? 200 : status.value();

                    TrafficData trafficData = new TrafficData();
                    trafficData.setTimestamp(System.currentTimeMillis());
                    trafficData.setMethod(exchange.getRequest().getMethod().name());
                    trafficData.setPath(exchange.getRequest().getURI().getPath());
                    trafficData.setStatusCode(statusCode);
                    trafficData.setDurationMs(System.currentTimeMillis() - start);
                    trafficData.setClientIp(ClientIpResolver.resolve(exchange.getRequest()));

                    // Fire-and-forget to avoid adding latency to request path.
                    auditEventPublisher.publish(trafficData);
                });
    }

    @Override
    public int getOrder() {
        return -300;
    }
}

