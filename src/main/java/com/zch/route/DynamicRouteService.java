package com.zch.route;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zch.config.GatewayRuntimeProperties;
import java.net.URI;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.cloud.gateway.event.RefreshRoutesEvent;
import org.springframework.cloud.gateway.filter.FilterDefinition;
import org.springframework.cloud.gateway.handler.predicate.PredicateDefinition;
import org.springframework.cloud.gateway.route.RouteDefinition;
import org.springframework.cloud.gateway.route.RouteDefinitionLocator;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.data.redis.core.ReactiveStringRedisTemplate;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

@Service
public class DynamicRouteService implements RouteDefinitionLocator {

    private static final Logger log = LoggerFactory.getLogger(DynamicRouteService.class);

    private final ReactiveStringRedisTemplate redisTemplate;
    private final ObjectMapper objectMapper;
    private final ApplicationEventPublisher eventPublisher;
    private final GatewayRuntimeProperties runtimeProperties;

    public DynamicRouteService(ReactiveStringRedisTemplate redisTemplate,
                               ObjectMapper objectMapper,
                               ApplicationEventPublisher eventPublisher,
                               GatewayRuntimeProperties runtimeProperties) {
        this.redisTemplate = redisTemplate;
        this.objectMapper = objectMapper;
        this.eventPublisher = eventPublisher;
        this.runtimeProperties = runtimeProperties;
    }

    @Override
    public Flux<RouteDefinition> getRouteDefinitions() {
        return routeDefinitions();
    }

    public Flux<RouteDefinition> routeDefinitions() {
        return list().flatMap(route -> {
            try {
                return Mono.just(toRouteDefinition(route));
            } catch (Exception e) {
                log.warn("Skipping route '{}' — failed to convert to RouteDefinition: {}", route.getId(), e.getMessage());
                return Mono.empty();
            }
        });
    }

    public Flux<RouteRuleDto> list() {
        return redisTemplate.opsForHash().entries(routeRedisKey())
                .flatMap(entry -> {
                    try {
                        return Mono.just(parse(String.valueOf(entry.getValue())));
                    } catch (Exception e) {
                        log.warn("Skipping corrupted route entry '{}': {}", entry.getKey(), e.getMessage());
                        return Mono.empty();
                    }
                })
                .sort(Comparator.comparing(RouteRuleDto::getId));
    }

    public Mono<RouteRuleDto> save(RouteRuleDto input) {
        RouteRuleDto normalized = normalize(input);
        return redisTemplate.opsForHash()
                .put(routeRedisKey(), normalized.getId(), stringify(normalized))
                .flatMap(ignore -> refresh().thenReturn(normalized));
    }

    public Mono<Boolean> delete(String id) {
        return redisTemplate.opsForHash()
                .remove(routeRedisKey(), id)
                .map(removed -> removed != null && removed > 0)
                .flatMap(removed -> removed ? refresh().thenReturn(Boolean.TRUE) : Mono.just(Boolean.FALSE));
    }

    private Mono<Void> refresh() {
        return Mono.fromRunnable(() -> eventPublisher.publishEvent(new RefreshRoutesEvent(this)));
    }

    private RouteRuleDto normalize(RouteRuleDto input) {
        RouteRuleDto route = new RouteRuleDto();
        String rawId = trimToNull(input.getId());
        route.setId(rawId == null ? "route-" + System.currentTimeMillis() : rawId);

        String path = trimToNull(input.getPath());
        route.setPath(path == null ? "/proxy/**" : path);

        String uri = trimToNull(input.getUri());
        if (uri != null) {
            // 校验 URI 合法性 —— 必须有 scheme，避免 Redis 脏数据导致启动崩溃
            if (isValidUri(uri)) {
                route.setUri(uri);
            } else {
                log.warn("Invalid URI '{}' for route '{}' (missing scheme), falling back to default", uri, route.getId());
                route.setUri("https://httpbin.org");
            }
        } else {
            route.setUri("https://httpbin.org");
        }

        route.setRewriteEnabled(input.isRewriteEnabled());

        String rewriteRegex = trimToNull(input.getRewriteRegex());
        if (rewriteRegex != null) {
            // 校验正则合法性 —— 避免 Redis 中脏数据导致 Pattern.compile 崩溃
            if (isValidRegex(rewriteRegex)) {
                route.setRewriteRegex(rewriteRegex);
            } else {
                log.warn("Invalid rewriteRegex '{}' for route '{}', falling back to default", rewriteRegex, route.getId());
                route.setRewriteRegex(defaultRewriteRegex(route.getPath()));
            }
        } else {
            route.setRewriteRegex(defaultRewriteRegex(route.getPath()));
        }

        String rewriteReplacement = trimToNull(input.getRewriteReplacement());
        route.setRewriteReplacement(rewriteReplacement == null ? "/${segment}" : rewriteReplacement);

        route.setCircuitBreakerEnabled(input.isCircuitBreakerEnabled());
        String breakerName = trimToNull(input.getCircuitBreakerName());
        route.setCircuitBreakerName(breakerName == null ? "cb-" + route.getId() : breakerName);

        String fallbackPath = trimToNull(input.getFallbackPath());
        route.setFallbackPath(fallbackPath == null ? "/fallback/default" : fallbackPath);
        return route;
    }

    private RouteDefinition toRouteDefinition(RouteRuleDto route) {
        RouteDefinition definition = new RouteDefinition();
        definition.setId(route.getId());
        definition.setUri(URI.create(route.getUri()));

        PredicateDefinition pathPredicate = new PredicateDefinition();
        pathPredicate.setName("Path");
        pathPredicate.addArg("pattern", route.getPath());
        definition.getPredicates().add(pathPredicate);

        if (route.isRewriteEnabled()) {
            FilterDefinition rewrite = new FilterDefinition();
            rewrite.setName("RewritePath");
            Map<String, String> rewriteArgs = new LinkedHashMap<>();
            rewriteArgs.put("regexp", route.getRewriteRegex());
            rewriteArgs.put("replacement", route.getRewriteReplacement());
            rewrite.setArgs(rewriteArgs);
            definition.getFilters().add(rewrite);
        }

        if (route.isCircuitBreakerEnabled()) {
            FilterDefinition cb = new FilterDefinition();
            cb.setName("CircuitBreaker");
            Map<String, String> cbArgs = new LinkedHashMap<>();
            cbArgs.put("name", route.getCircuitBreakerName());
            cbArgs.put("fallbackUri", "forward:" + route.getFallbackPath());
            cb.setArgs(cbArgs);
            definition.getFilters().add(cb);
        }

        return definition;
    }

    private RouteRuleDto parse(String json) {
        try {
            return normalize(objectMapper.readValue(json, RouteRuleDto.class));
        } catch (JsonProcessingException ex) {
            throw new IllegalArgumentException("Invalid route definition json", ex);
        }
    }

    private String stringify(RouteRuleDto route) {
        try {
            return objectMapper.writeValueAsString(route);
        } catch (JsonProcessingException ex) {
            throw new IllegalArgumentException("Failed to serialize route", ex);
        }
    }

    private String routeRedisKey() {
        return runtimeProperties.getRoute().getRedisKey();
    }

    private String trimToNull(String value) {
        if (value == null) {
            return null;
        }
        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    /**
     * 合法 URI 必须包含 scheme（如 http://, https://, lb://）。
     * 像 /api/user/1 这样的路径不是合法 URI。
     */
    private boolean isValidUri(String candidate) {
        try {
            URI uri = URI.create(candidate);
            return uri.getScheme() != null && !uri.getScheme().isBlank();
        } catch (IllegalArgumentException e) {
            return false;
        }
    }

    private boolean isValidRegex(String candidate) {
        try {
            Pattern.compile(candidate);
            return true;
        } catch (PatternSyntaxException e) {
            return false;
        }
    }

    private String defaultRewriteRegex(String pathPattern) {
        String prefix = "/proxy";
        if (pathPattern != null && pathPattern.endsWith("/**")) {
            prefix = pathPattern.substring(0, pathPattern.length() - 3);
            if (prefix.isEmpty()) {
                prefix = "/";
            }
        }
        if ("/".equals(prefix)) {
            return "/(?<segment>.*)";
        }
        return prefix + "/(?<segment>.*)";
    }

}

