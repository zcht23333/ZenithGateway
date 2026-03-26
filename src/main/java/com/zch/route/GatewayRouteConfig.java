package com.zch.route;

import org.springframework.cloud.gateway.route.RouteDefinitionLocator;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class GatewayRouteConfig {

    @Bean
    public RouteDefinitionLocator routeDefinitionLocator(DynamicRouteService dynamicRouteService) {
        return dynamicRouteService::routeDefinitions;
    }
}

