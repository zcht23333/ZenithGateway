package com.zch.monitor;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zch.config.GatewayRuntimeProperties;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.core.ReactiveStringRedisTemplate;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.core.publisher.Sinks;

@Component
public class AuditEventPublisher {

    private static final Logger log = LoggerFactory.getLogger(AuditEventPublisher.class);

    private final ReactiveStringRedisTemplate redisTemplate;
    private final ObjectMapper objectMapper;
    private final GatewayRuntimeProperties runtimeProperties;
    private final Sinks.Many<TrafficData> sink;

    public AuditEventPublisher(ReactiveStringRedisTemplate redisTemplate,
                               ObjectMapper objectMapper,
                               GatewayRuntimeProperties runtimeProperties) {
        this.redisTemplate = redisTemplate;
        this.objectMapper = objectMapper;
        this.runtimeProperties = runtimeProperties;
        this.sink = Sinks.many().multicast().onBackpressureBuffer(runtimeProperties.getAudit().getBufferSize(), false);
    }

    @PostConstruct
    public void init() {
        sink.asFlux()
                .flatMap(this::persistToRedis)
                .onErrorContinue((error, dropped) -> log.warn("Drop audit event due to async pipeline error: {}", error.getMessage()))
                .subscribe();
    }

    public void publish(TrafficData trafficData) {
        Sinks.EmitResult result = sink.tryEmitNext(trafficData);
        if (result.isFailure()) {
            log.warn("Audit event dropped due to sink pressure. reason={}", result);
        }
    }

    public Flux<TrafficData> stream() {
        return sink.asFlux();
    }

    private Mono<Long> persistToRedis(TrafficData trafficData) {
        String payload;
        try {
            payload = objectMapper.writeValueAsString(trafficData);
        } catch (JsonProcessingException e) {
            return Mono.error(e);
        }

        String key = runtimeProperties.getAudit().getRedisKey();
        int maxEntries = runtimeProperties.getAudit().getRedisMaxEntries();

        return redisTemplate.opsForList().leftPush(key, payload)
                .flatMap(pushCount -> redisTemplate.opsForList().trim(key, 0, maxEntries - 1).thenReturn(pushCount));
    }
}

