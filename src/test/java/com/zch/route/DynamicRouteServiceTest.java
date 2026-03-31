package com.zch.route;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zch.config.GatewayRuntimeProperties;
import java.util.AbstractMap;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.data.redis.core.ReactiveHashOperations;
import org.springframework.data.redis.core.ReactiveStringRedisTemplate;
import reactor.core.publisher.Flux;
import reactor.test.StepVerifier;

class DynamicRouteServiceTest {

    @Test
    void shouldExposeRedisRoutesThroughRouteDefinitionLocator() throws Exception {
        ReactiveStringRedisTemplate redisTemplate = Mockito.mock(ReactiveStringRedisTemplate.class);
        @SuppressWarnings("unchecked")
        ReactiveHashOperations<String, Object, Object> hashOperations = Mockito.mock(ReactiveHashOperations.class);
        Mockito.when(redisTemplate.opsForHash()).thenReturn(hashOperations);

        RouteRuleDto route = new RouteRuleDto();
        route.setId("demo");
        route.setPath("/demo/**");
        route.setUri("https://example.org");
        route.setRewriteEnabled(false);
        route.setCircuitBreakerEnabled(false);

        ObjectMapper objectMapper = new ObjectMapper();
        String json = objectMapper.writeValueAsString(route);

        Mockito.when(hashOperations.entries("zg:routes"))
                .thenReturn(Flux.just(new AbstractMap.SimpleEntry<>("demo", json)));

        GatewayRuntimeProperties properties = new GatewayRuntimeProperties();
        ApplicationEventPublisher eventPublisher = Mockito.mock(ApplicationEventPublisher.class);

        DynamicRouteService service = new DynamicRouteService(redisTemplate, objectMapper, eventPublisher, properties);

        StepVerifier.create(service.getRouteDefinitions())
                .assertNext(definition -> {
                    Assertions.assertEquals("demo", definition.getId());
                    Assertions.assertEquals("https://example.org", definition.getUri().toString());
                    Assertions.assertFalse(definition.getPredicates().isEmpty());
                })
                .verifyComplete();
    }
}

