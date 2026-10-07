package com.zch.route;
import com.zch.config.RuntimeConfigSyncProperties;
import org.springframework.cloud.gateway.filter.GlobalFilter;
import org.springframework.cloud.gateway.route.Route;
import org.springframework.cloud.gateway.route.RouteLocator;
import org.springframework.cloud.gateway.support.ServerWebExchangeUtils;
import org.springframework.context.annotation.*;
import org.springframework.core.Ordered;
@Configuration(proxyBeanMethods=false)
public class RoutePublicationConfiguration {
    // Gateway's default CachingRouteLocator backs off by this exact bean name (5.0.3).
    @Bean(name="cachedCompositeRouteLocator") @Primary
    RouteLocator forwardingRouteLocator(ActiveRoutes active){return active::getRoutes;}
    @Bean GlobalFilter routeVersionResponse(RuntimeConfigSyncProperties identity){return new VersionFilter(identity.getInstanceId());}
    private record VersionFilter(String instance) implements GlobalFilter,Ordered {
        public int getOrder(){return -1000;}
        public reactor.core.publisher.Mono<Void> filter(org.springframework.web.server.ServerWebExchange exchange,org.springframework.cloud.gateway.filter.GatewayFilterChain chain){
            Route route=exchange.getAttribute(ServerWebExchangeUtils.GATEWAY_ROUTE_ATTR);
            if(route!=null&&route.getMetadata().containsKey(RouteCompiler.VERSION)){
                // NettyRoutingFilter adds upstream headers later. Stamp our matching evidence only at commit.
                exchange.getResponse().beforeCommit(()->{
                    exchange.getResponse().getHeaders().set("X-Zenith-Route-Version",String.valueOf(route.getMetadata().get(RouteCompiler.VERSION)));
                    exchange.getResponse().getHeaders().set("X-Zenith-Instance",instance);
                    return reactor.core.publisher.Mono.empty();
                });
            }
            return chain.filter(exchange);
        }
    }
}
