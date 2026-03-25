package com.zch.filter;

import com.zch.config.GatewayRuntimeProperties;
import com.zch.util.ClientIpResolver;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import org.springframework.cloud.gateway.filter.GatewayFilterChain;
import org.springframework.cloud.gateway.filter.GlobalFilter;
import org.springframework.core.Ordered;
import org.springframework.data.redis.core.ReactiveStringRedisTemplate;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;

@Component
public class RateLimitFilter implements GlobalFilter, Ordered {

    private final ReactiveStringRedisTemplate redisTemplate;
    private final GatewayRuntimeProperties runtimeProperties;

    public RateLimitFilter(ReactiveStringRedisTemplate redisTemplate,
                           GatewayRuntimeProperties runtimeProperties) {
        this.redisTemplate = redisTemplate;
        this.runtimeProperties = runtimeProperties;
    }

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
        GatewayRuntimeProperties.RateLimit rateLimit = runtimeProperties.getRateLimit();
        if (!rateLimit.isEnabled()) {
            return chain.filter(exchange);
        }

        String clientIp = ClientIpResolver.resolve(exchange.getRequest());
        long bucket = Instant.now().getEpochSecond() / Math.max(1, rateLimit.getWindowSeconds());
        String key = "zg:rl:" + clientIp + ":" + bucket;

        return redisTemplate.opsForValue().increment(key)
                .flatMap(count -> {
                    Mono<Boolean> expireMono = count == 1
                            ? redisTemplate.expire(key, Duration.ofSeconds(Math.max(1, rateLimit.getWindowSeconds())))
                            : Mono.just(Boolean.TRUE);

                    return expireMono.flatMap(ignore -> {
                        if (count > rateLimit.getRequestsPerWindow()) {
                            return writeTooManyRequests(exchange, rateLimit.getWindowSeconds());
                        }
                        return chain.filter(exchange);
                    });
                });
    }

    @Override
    public int getOrder() {
        return -200;
    }

    private Mono<Void> writeTooManyRequests(ServerWebExchange exchange, int windowSeconds) {
        exchange.getResponse().setStatusCode(HttpStatus.TOO_MANY_REQUESTS);
        exchange.getResponse().getHeaders().setContentType(MediaType.APPLICATION_JSON);
        String payload = "{\"code\":429,\"message\":\"Too many requests\",\"windowSeconds\":" + windowSeconds + "}";
        byte[] bytes = payload.getBytes(StandardCharsets.UTF_8);
        return exchange.getResponse().writeWith(Mono.just(exchange.getResponse().bufferFactory().wrap(bytes)));
    }
}

