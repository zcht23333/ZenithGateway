package com.zch.route;

import org.springframework.cloud.gateway.route.RouteLocator;
import org.springframework.cloud.gateway.route.builder.RouteLocatorBuilder;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class GatewayRouteConfig {

    @Bean
    public RouteLocator routeLocator(RouteLocatorBuilder builder) {
        return builder.routes()
                .route("httpbin-anything", r -> r
                        .path("/proxy/**")
                        .filters(f -> f.rewritePath("/proxy/(?<segment>.*)", "/anything/${segment}"))
                        .uri("https://httpbin.org"))
                .build();
    }
}

