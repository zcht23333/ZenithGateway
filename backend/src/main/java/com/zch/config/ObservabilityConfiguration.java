package com.zch.config;

import io.micrometer.core.instrument.config.MeterFilter;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration(proxyBeanMethods = false)
public class ObservabilityConfiguration {
    @Bean
    MeterFilter boundedHttpUriTags() {
        return MeterFilter.maximumAllowableTags("http.server.requests", "uri", 100, MeterFilter.deny());
    }
    @Bean
    MeterFilter boundedGatewayRouteTags() {
        return MeterFilter.maximumAllowableTags("spring.cloud.gateway.requests", "routeId", 100, MeterFilter.deny());
    }
}
