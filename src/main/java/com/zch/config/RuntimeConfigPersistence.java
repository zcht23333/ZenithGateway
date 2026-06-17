package com.zch.config;

import static com.zch.config.ConfigUtils.clamp;
import static com.zch.config.ConfigUtils.readBoolean;
import static com.zch.config.ConfigUtils.readInt;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.data.redis.core.ReactiveStringRedisTemplate;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Mono;

/**
 * 运行时配置的 Redis 持久化层。
 *
 * 启动时同步从 Redis 加载（优先于 application.yml），确保在接受流量前配置已就位。
 * 更新时先写 Redis 再更新内存快照，保证重启不丢配置。
 */
@Service
public class RuntimeConfigPersistence implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(RuntimeConfigPersistence.class);

    /** 启动时等待 Redis 响应的最长时间 */
    private static final Duration STARTUP_LOAD_TIMEOUT = Duration.ofSeconds(5);

    private static final String REDIS_KEY = "zg:runtime:config";

    private final ReactiveStringRedisTemplate redisTemplate;
    private final ObjectMapper objectMapper;
    private final GatewayRuntimeProperties properties;

    public RuntimeConfigPersistence(ReactiveStringRedisTemplate redisTemplate,
                                    ObjectMapper objectMapper,
                                    GatewayRuntimeProperties properties) {
        this.redisTemplate = redisTemplate;
        this.objectMapper = objectMapper;
        this.properties = properties;
    }

    /**
     * 启动时同步阻塞加载 Redis 配置。
     * ApplicationRunner 在 Web 服务器启动前执行，保证接受流量时配置已就位。
     * 超时或失败时保留 application.yml 默认值。
     */
    @Override
    public void run(ApplicationArguments args) {
        try {
            redisTemplate.opsForValue()
                    .get(REDIS_KEY)
                    .flatMap(this::deserialize)
                    .doOnNext(configMap -> {
                        apply(configMap);
                        log.info("Loaded runtime config from Redis key={}", REDIS_KEY);
                    })
                    .block(STARTUP_LOAD_TIMEOUT);
        } catch (Exception e) {
            log.warn("Failed to load runtime config from Redis ({}) — keeping application.yml defaults", e.getMessage());
        }
    }

    /**
     * 持久化当前内存配置到 Redis（先写 Redis 再更新内存）。
     */
    public Mono<Void> persist(RateLimitConfig rateLimit, MonitorConfig monitor) {
        Map<String, Object> payload = toMap(rateLimit, monitor);
        String json;
        try {
            json = objectMapper.writeValueAsString(payload);
        } catch (JsonProcessingException e) {
            return Mono.error(e);
        }

        return redisTemplate.opsForValue()
                .set(REDIS_KEY, json)
                .doOnSuccess(ignored -> {
                    // 先持久化成功，再更新内存快照（保证崩溃不丢配置）
                    properties.updateRateLimit(rateLimit);
                    properties.updateMonitor(monitor);
                    log.debug("Persisted runtime config to Redis key={}", REDIS_KEY);
                })
                .then();
    }

    @SuppressWarnings("unchecked")
    private Mono<Map<String, Object>> deserialize(String json) {
        try {
            return Mono.just(objectMapper.readValue(json, Map.class));
        } catch (JsonProcessingException e) {
            return Mono.error(e);
        }
    }

    private void apply(Map<String, Object> configMap) {
        RateLimitConfig currentRateLimit = properties.getRateLimit();
        RateLimitConfig rateLimit = new RateLimitConfig(
                readBoolean(configMap, "rateLimitEnabled", currentRateLimit.enabled()),
                clamp(readInt(configMap, "replenishRate", currentRateLimit.replenishRate()), 1, 10000),
                clamp(readInt(configMap, "burstCapacity", currentRateLimit.burstCapacity()), 1, 10000),
                clamp(readInt(configMap, "requestedTokens", currentRateLimit.requestedTokens()), 1, 100)
        );

        MonitorConfig currentMonitor = properties.getMonitor();
        MonitorConfig monitor = new MonitorConfig(
                clamp(readInt(configMap, "monitorWindowSeconds", currentMonitor.windowSeconds()), 1, 120),
                clamp(readInt(configMap, "emitIntervalSeconds", currentMonitor.emitIntervalSeconds()), 1, 5)
        );

        properties.updateRateLimit(rateLimit);
        properties.updateMonitor(monitor);
    }

    private Map<String, Object> toMap(RateLimitConfig rateLimit, MonitorConfig monitor) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("rateLimitEnabled", rateLimit.enabled());
        map.put("replenishRate", rateLimit.replenishRate());
        map.put("burstCapacity", rateLimit.burstCapacity());
        map.put("requestedTokens", rateLimit.requestedTokens());
        map.put("monitorWindowSeconds", monitor.windowSeconds());
        map.put("emitIntervalSeconds", monitor.emitIntervalSeconds());
        return map;
    }

}
