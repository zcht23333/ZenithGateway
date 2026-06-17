package com.zch.filter;

import com.zch.config.GatewayRuntimeProperties;
import com.zch.config.RateLimitConfig;
import java.util.List;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.cloud.gateway.filter.GatewayFilterChain;
import org.springframework.data.redis.core.ReactiveStringRedisTemplate;
import org.springframework.data.redis.core.script.RedisScript;
import org.springframework.mock.http.server.reactive.MockServerHttpRequest;
import org.springframework.mock.web.server.MockServerWebExchange;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.test.StepVerifier;

class RateLimitFilterTest {

    private ReactiveStringRedisTemplate redisTemplate;
    private GatewayRuntimeProperties properties;
    private RateLimitFilter filter;

    @BeforeEach
    @SuppressWarnings("unchecked")
    void setUp() {
        redisTemplate = Mockito.mock(ReactiveStringRedisTemplate.class);
        properties = new GatewayRuntimeProperties();
        filter = new RateLimitFilter(redisTemplate, properties);
    }

    @Test
    void shouldPassThroughWhenRateLimitDisabled() {
        RateLimitConfig disabled = properties.getRateLimit().withEnabled(false);
        properties.updateRateLimit(disabled);

        ServerWebExchange exchange = MockServerWebExchange.from(
                MockServerHttpRequest.get("/proxy/test").build());

        GatewayFilterChain chain = Mockito.mock(GatewayFilterChain.class);
        Mockito.when(chain.filter(exchange)).thenReturn(Mono.empty());

        StepVerifier.create(filter.filter(exchange, chain))
                .verifyComplete();

        Mockito.verify(chain).filter(exchange);
        Mockito.verifyNoInteractions(redisTemplate);
    }

    @Test
    @SuppressWarnings("unchecked")
    void shouldBlockRequestWhenTokenBucketEmpty() {
        RateLimitConfig aggressive = new RateLimitConfig(true, 1, 1, 1);
        properties.updateRateLimit(aggressive);

        ServerWebExchange exchange = MockServerWebExchange.from(
                MockServerHttpRequest.get("/proxy/test").build());

        // 模拟 Redis Lua 返回 0（不允许通行）
        Mockito.when(redisTemplate.execute(
                        Mockito.<RedisScript<Long>>any(),
                        Mockito.<List<String>>any(),
                        Mockito.<List<String>>any()))
                .thenReturn(Flux.just(0L));

        GatewayFilterChain chain = Mockito.mock(GatewayFilterChain.class);

        StepVerifier.create(filter.filter(exchange, chain))
                .verifyComplete();

        Assertions.assertEquals(429, exchange.getResponse().getStatusCode().value());
        Mockito.verify(chain, Mockito.never()).filter(exchange);
    }

    @Test
    @SuppressWarnings("unchecked")
    void shouldAllowRequestWhenTokenBucketHasTokens() {
        RateLimitConfig generous = new RateLimitConfig(true, 100, 100, 1);
        properties.updateRateLimit(generous);

        ServerWebExchange exchange = MockServerWebExchange.from(
                MockServerHttpRequest.get("/proxy/test").build());

        // 模拟 Redis Lua 返回 1（允许通行）
        Mockito.when(redisTemplate.execute(
                        Mockito.<RedisScript<Long>>any(),
                        Mockito.<List<String>>any(),
                        Mockito.<List<String>>any()))
                .thenReturn(Flux.just(1L));

        GatewayFilterChain chain = Mockito.mock(GatewayFilterChain.class);
        Mockito.when(chain.filter(exchange)).thenReturn(Mono.empty());

        StepVerifier.create(filter.filter(exchange, chain))
                .verifyComplete();

        Mockito.verify(chain).filter(exchange);
    }

    @Test
    void shouldReturn429JsonWhenBlocked() {
        RateLimitConfig strict = new RateLimitConfig(true, 1, 1, 1);
        properties.updateRateLimit(strict);

        ServerWebExchange exchange = MockServerWebExchange.from(
                MockServerHttpRequest.get("/proxy/test").build());

        Mockito.when(redisTemplate.execute(
                        Mockito.<RedisScript<Long>>any(),
                        Mockito.<List<String>>any(),
                        Mockito.<List<String>>any()))
                .thenReturn(Flux.just(0L));

        GatewayFilterChain chain = Mockito.mock(GatewayFilterChain.class);

        StepVerifier.create(filter.filter(exchange, chain))
                .verifyComplete();

        Assertions.assertEquals(429, exchange.getResponse().getStatusCode().value());
        Assertions.assertNotNull(exchange.getResponse().getHeaders().getFirst("Retry-After"));
        Assertions.assertTrue(
                exchange.getResponse().getHeaders().getContentType().toString()
                        .contains("application/json"));
    }

    @Test
    @SuppressWarnings("unchecked")
    void shouldFailOpenWhenRedisUnavailable() {
        RateLimitConfig config = new RateLimitConfig(true, 10, 10, 1);
        properties.updateRateLimit(config);

        ServerWebExchange exchange = MockServerWebExchange.from(
                MockServerHttpRequest.get("/proxy/test").build());

        // 模拟 Redis 异常（连接断开、超时等）
        Mockito.when(redisTemplate.execute(
                        Mockito.<RedisScript<Long>>any(),
                        Mockito.<List<String>>any(),
                        Mockito.<List<String>>any()))
                .thenReturn(Flux.error(new RuntimeException("Connection refused")));

        GatewayFilterChain chain = Mockito.mock(GatewayFilterChain.class);
        Mockito.when(chain.filter(exchange)).thenReturn(Mono.empty());

        // Redis 故障时应 fail-open（放行请求），不返回 429
        StepVerifier.create(filter.filter(exchange, chain))
                .verifyComplete();

        Mockito.verify(chain).filter(exchange);
        Assertions.assertNotEquals(429, exchange.getResponse().getStatusCode() != null
                ? exchange.getResponse().getStatusCode().value() : -1);
    }
}
