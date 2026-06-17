package com.zch.route;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zch.config.GatewayRuntimeProperties;
import java.util.AbstractMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.cloud.gateway.filter.FilterDefinition;
import org.springframework.cloud.gateway.route.RouteDefinition;
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

    @Test
    void shouldFallbackUriToDefaultWhenMissingScheme() throws Exception {
        ReactiveStringRedisTemplate redisTemplate = Mockito.mock(ReactiveStringRedisTemplate.class);
        @SuppressWarnings("unchecked")
        ReactiveHashOperations<String, Object, Object> hashOperations = Mockito.mock(ReactiveHashOperations.class);
        Mockito.when(redisTemplate.opsForHash()).thenReturn(hashOperations);

        // URI 缺少 scheme，如 /api/user/1 —— 来自脏数据的典型场景
        RouteRuleDto route = new RouteRuleDto();
        route.setId("bad-uri");
        route.setPath("/bad/**");
        route.setUri("/api/user/1");  // ❌ 无 scheme
        route.setRewriteEnabled(false);
        route.setCircuitBreakerEnabled(false);

        ObjectMapper objectMapper = new ObjectMapper();
        String json = objectMapper.writeValueAsString(route);

        Mockito.when(hashOperations.entries("zg:routes"))
                .thenReturn(Flux.just(new AbstractMap.SimpleEntry<>("bad-uri", json)));

        GatewayRuntimeProperties properties = new GatewayRuntimeProperties();
        ApplicationEventPublisher eventPublisher = Mockito.mock(ApplicationEventPublisher.class);
        DynamicRouteService service = new DynamicRouteService(redisTemplate, objectMapper, eventPublisher, properties);

        StepVerifier.create(service.getRouteDefinitions())
                .assertNext(definition -> {
                    Assertions.assertEquals("bad-uri", definition.getId());
                    // 应回退到默认 URI
                    Assertions.assertEquals("https://httpbin.org", definition.getUri().toString());
                })
                .verifyComplete();
    }

    @Test
    void shouldSkipCorruptedEntryAndLoadRemainingRoutes() throws Exception {
        ReactiveStringRedisTemplate redisTemplate = Mockito.mock(ReactiveStringRedisTemplate.class);
        @SuppressWarnings("unchecked")
        ReactiveHashOperations<String, Object, Object> hashOperations = Mockito.mock(ReactiveHashOperations.class);
        Mockito.when(redisTemplate.opsForHash()).thenReturn(hashOperations);

        RouteRuleDto goodRoute = new RouteRuleDto();
        goodRoute.setId("good");
        goodRoute.setPath("/good/**");
        goodRoute.setUri("https://example.org");
        goodRoute.setRewriteEnabled(false);
        goodRoute.setCircuitBreakerEnabled(false);

        ObjectMapper objectMapper = new ObjectMapper();
        String goodJson = objectMapper.writeValueAsString(goodRoute);
        String badJson = "{this is not valid json at all !!!";

        Mockito.when(hashOperations.entries("zg:routes"))
                .thenReturn(Flux.just(
                        new AbstractMap.SimpleEntry<>("bad-entry", badJson),
                        new AbstractMap.SimpleEntry<>("good", goodJson)
                ));

        GatewayRuntimeProperties properties = new GatewayRuntimeProperties();
        ApplicationEventPublisher eventPublisher = Mockito.mock(ApplicationEventPublisher.class);
        DynamicRouteService service = new DynamicRouteService(redisTemplate, objectMapper, eventPublisher, properties);

        // 应该只加载 good 路由，跳过 bad-entry
        StepVerifier.create(service.getRouteDefinitions())
                .assertNext(definition -> {
                    Assertions.assertEquals("good", definition.getId());
                })
                .verifyComplete();
    }

    @Test
    void shouldFallbackRegexToDefaultWhenInvalidPattern() throws Exception {
        ReactiveStringRedisTemplate redisTemplate = Mockito.mock(ReactiveStringRedisTemplate.class);
        @SuppressWarnings("unchecked")
        ReactiveHashOperations<String, Object, Object> hashOperations = Mockito.mock(ReactiveHashOperations.class);
        Mockito.when(redisTemplate.opsForHash()).thenReturn(hashOperations);

        // rewriteRegex 是非法正则 —— 典型脏数据场景
        RouteRuleDto route = new RouteRuleDto();
        route.setId("bad-regex");
        route.setPath("/demo/**");
        route.setUri("https://example.org");
        route.setRewriteEnabled(true);
        route.setRewriteRegex("/anything/${segment}");  // ❌ 不是合法正则
        route.setRewriteReplacement("/anything/${segment}");
        route.setCircuitBreakerEnabled(false);

        ObjectMapper objectMapper = new ObjectMapper();
        String json = objectMapper.writeValueAsString(route);

        Mockito.when(hashOperations.entries("zg:routes"))
                .thenReturn(Flux.just(new AbstractMap.SimpleEntry<>("bad-regex", json)));

        GatewayRuntimeProperties properties = new GatewayRuntimeProperties();
        ApplicationEventPublisher eventPublisher = Mockito.mock(ApplicationEventPublisher.class);
        DynamicRouteService service = new DynamicRouteService(redisTemplate, objectMapper, eventPublisher, properties);

        StepVerifier.create(service.getRouteDefinitions())
                .assertNext(definition -> {
                    Assertions.assertEquals("bad-regex", definition.getId());
                    // 应回退到根据 path 生成的默认正则
                    FilterDefinition rewriteFilter = definition.getFilters().stream()
                            .filter(f -> "RewritePath".equals(f.getName()))
                            .findFirst()
                            .orElseThrow();
                    String actualRegex = rewriteFilter.getArgs().get("regexp");
                    Assertions.assertNotNull(actualRegex);
                    Assertions.assertTrue(actualRegex.contains("(?<segment>.*)"),
                            "should be a valid regex with named group, got: " + actualRegex);
                    // 确保不是原来的脏数据
                    Assertions.assertFalse(actualRegex.contains("${segment}"),
                            "should NOT contain ${segment}");
                })
                .verifyComplete();
    }
}

