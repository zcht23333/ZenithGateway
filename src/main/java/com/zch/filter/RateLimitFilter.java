package com.zch.filter;

import com.zch.config.GatewayRuntimeProperties;
import com.zch.config.RateLimitConfig;
import com.zch.util.ClientIpResolver;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.Collections;
import java.util.List;
import org.springframework.cloud.gateway.filter.GatewayFilterChain;
import org.springframework.cloud.gateway.filter.GlobalFilter;
import org.springframework.core.Ordered;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.core.ReactiveStringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;

@Component
public class RateLimitFilter implements GlobalFilter, Ordered {

    private static final Logger log = LoggerFactory.getLogger(RateLimitFilter.class);

    /** Redis Lua 脚本执行超时。超过此时长则 fail-open 放行请求。 */
    private static final Duration REDIS_TIMEOUT = Duration.ofMillis(500);

    private static final String TOKEN_BUCKET_SCRIPT = """
            local key = KEYS[1]
            local capacity = tonumber(ARGV[1])
            local replenish = tonumber(ARGV[2])
            local requested = tonumber(ARGV[3])
            local now = tonumber(ARGV[4])
            local ttl = tonumber(ARGV[5])

            local data = redis.call('HMGET', key, 'tokens', 'ts')
            local tokens = tonumber(data[1])
            local ts = tonumber(data[2])

            if tokens == nil then
              tokens = capacity
            end

            if ts == nil then
              ts = now
            end

            local delta = math.max(0, now - ts) / 1000.0
            tokens = math.min(capacity, tokens + (delta * replenish))

            local allowed = 0
            if tokens >= requested then
              tokens = tokens - requested
              allowed = 1
            end

            redis.call('HMSET', key, 'tokens', tokens, 'ts', now)
            redis.call('EXPIRE', key, ttl)
            return allowed
            """;

    private final ReactiveStringRedisTemplate redisTemplate;
    private final GatewayRuntimeProperties runtimeProperties;
    private final DefaultRedisScript<Long> tokenBucketScript;

    public RateLimitFilter(ReactiveStringRedisTemplate redisTemplate,
                           GatewayRuntimeProperties runtimeProperties) {
        this.redisTemplate = redisTemplate;
        this.runtimeProperties = runtimeProperties;
        this.tokenBucketScript = new DefaultRedisScript<>();
        this.tokenBucketScript.setScriptText(TOKEN_BUCKET_SCRIPT);
        this.tokenBucketScript.setResultType(Long.class);
    }

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
        // AtomicReference.get() = volatile read，保证看到 Controller 写入的最新配置
        RateLimitConfig rateLimit = runtimeProperties.getRateLimit();
        if (!rateLimit.enabled()) {
            return chain.filter(exchange);
        }

        String clientIp = ClientIpResolver.resolve(exchange.getRequest());
        String key = "zg:rl:tb:" + clientIp;
        int burstCapacity = Math.max(1, rateLimit.burstCapacity());
        int replenishRate = Math.max(1, rateLimit.replenishRate());
        int requestedTokens = Math.max(1, rateLimit.requestedTokens());
        long nowMs = Instant.now().toEpochMilli();
        int ttlSeconds = Math.max(2, (burstCapacity / replenishRate) + 2);
        List<String> keys = Collections.singletonList(key);
        List<String> args = List.of(
                String.valueOf(burstCapacity),
                String.valueOf(replenishRate),
                String.valueOf(requestedTokens),
                String.valueOf(nowMs),
                String.valueOf(ttlSeconds)
        );

        return redisTemplate.execute(tokenBucketScript, keys, args)
                .next()
                .defaultIfEmpty(0L)
                .timeout(REDIS_TIMEOUT)
                .onErrorResume(error -> {
                    // Redis 不可用时 fail-open：放行请求并记录警告，避免网关全线阻塞
                    log.warn("Rate-limit Redis unavailable ({}), failing open for {} {}",
                            error.getMessage(), exchange.getRequest().getMethod(), exchange.getRequest().getURI().getPath());
                    return Mono.just(1L); // 1 = 放行
                })
                .flatMap(allowed -> {
                    if (allowed == 1L) {
                        return chain.filter(exchange);
                    }
                    return writeTooManyRequests(exchange, replenishRate);
                });
    }

    @Override
    public int getOrder() {
        return -200;
    }

    private Mono<Void> writeTooManyRequests(ServerWebExchange exchange, int replenishRate) {
        exchange.getResponse().setStatusCode(HttpStatus.TOO_MANY_REQUESTS);
        exchange.getResponse().getHeaders().setContentType(MediaType.APPLICATION_JSON);
        int retryAfter = Math.max(1, (int) Math.ceil(1.0 / replenishRate));
        exchange.getResponse().getHeaders().set("Retry-After", String.valueOf(retryAfter));
        String payload = "{\"code\":429,\"message\":\"Too many requests\",\"retryAfterSeconds\":" + retryAfter + "}";
        byte[] bytes = payload.getBytes(StandardCharsets.UTF_8);
        return exchange.getResponse().writeWith(Mono.just(exchange.getResponse().bufferFactory().wrap(bytes)));
    }
}
