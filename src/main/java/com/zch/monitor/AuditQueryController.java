package com.zch.monitor;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zch.config.GatewayRuntimeProperties;
import java.util.Collections;
import java.util.List;
import org.springframework.data.redis.core.ReactiveStringRedisTemplate;
import org.springframework.util.StringUtils;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Mono;

@RestController
@RequestMapping("/monitor")
public class AuditQueryController {

    private final ReactiveStringRedisTemplate redisTemplate;
    private final ObjectMapper objectMapper;
    private final GatewayRuntimeProperties runtimeProperties;

    public AuditQueryController(ReactiveStringRedisTemplate redisTemplate,
                                ObjectMapper objectMapper,
                                GatewayRuntimeProperties runtimeProperties) {
        this.redisTemplate = redisTemplate;
        this.objectMapper = objectMapper;
        this.runtimeProperties = runtimeProperties;
    }

    @GetMapping("/audit/recent")
    public Mono<List<TrafficData>> recent(@RequestParam(defaultValue = "20") int size) {
        int safeSize = Math.max(1, Math.min(size, 200));
        String key = runtimeProperties.getAudit().getRedisKey();

        return redisTemplate.opsForList().range(key, 0, safeSize - 1)
                .filter(StringUtils::hasText)
                .flatMap(this::readTrafficData)
                .collectList()
                .defaultIfEmpty(Collections.emptyList());
    }

    private Mono<TrafficData> readTrafficData(String payload) {
        try {
            return Mono.just(objectMapper.readValue(payload, TrafficData.class));
        } catch (Exception e) {
            return Mono.empty();
        }
    }
}

