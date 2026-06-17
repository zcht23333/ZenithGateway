package com.zch.config;

import static com.zch.config.ConfigUtils.clamp;
import static com.zch.config.ConfigUtils.readBoolean;
import static com.zch.config.ConfigUtils.readInt;

import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Mono;

@RestController
@RequestMapping("/settings")
public class RuntimeConfigController {

    private final GatewayRuntimeProperties runtimeProperties;
    private final RuntimeConfigPersistence persistence;
    private final AdminAuthProperties authProperties;

    public RuntimeConfigController(GatewayRuntimeProperties runtimeProperties,
                                   RuntimeConfigPersistence persistence,
                                   AdminAuthProperties authProperties) {
        this.runtimeProperties = runtimeProperties;
        this.persistence = persistence;
        this.authProperties = authProperties;
    }

    /**
     * SSE 流专用 token —— 作用域仅限 /monitor/stream。
     * 与主 admin token 分离，避免 SSE URL 中的 query parameter 泄露管理权限。
     */
    @GetMapping("/sse-token")
    public Mono<Map<String, Object>> sseToken() {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("token", authProperties.getSseToken());
        return Mono.just(payload);
    }

    @GetMapping("/runtime")
    public Mono<Map<String, Object>> current() {
        return Mono.fromSupplier(this::toResponse);
    }

    @PutMapping("/runtime")
    public Mono<Map<String, Object>> update(@RequestBody Map<String, Object> request) {
        RateLimitConfig currentRateLimit = runtimeProperties.getRateLimit();
        MonitorConfig currentMonitor = runtimeProperties.getMonitor();

        RateLimitConfig nextRateLimit = currentRateLimit
                .withEnabled(readBoolean(request, "rateLimitEnabled", currentRateLimit.enabled()))
                .withReplenishRate(clamp(readInt(request, "replenishRate", currentRateLimit.replenishRate()), 1, 10000))
                .withBurstCapacity(clamp(readInt(request, "burstCapacity", currentRateLimit.burstCapacity()), 1, 10000))
                .withRequestedTokens(clamp(readInt(request, "requestedTokens", currentRateLimit.requestedTokens()), 1, 100));

        MonitorConfig nextMonitor = currentMonitor
                .withWindowSeconds(clamp(readInt(request, "monitorWindowSeconds", currentMonitor.windowSeconds()), 1, 120))
                .withEmitIntervalSeconds(clamp(readInt(request, "emitIntervalSeconds", currentMonitor.emitIntervalSeconds()), 1, 5));

        // 先写 Redis，成功后再更新内存快照（persist 内部保证顺序）
        return persistence.persist(nextRateLimit, nextMonitor)
                .then(Mono.fromSupplier(this::toResponse));
    }

    private Map<String, Object> toResponse() {
        RateLimitConfig rateLimit = runtimeProperties.getRateLimit();
        MonitorConfig monitor = runtimeProperties.getMonitor();

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("rateLimitEnabled", rateLimit.enabled());
        payload.put("replenishRate", rateLimit.replenishRate());
        payload.put("burstCapacity", rateLimit.burstCapacity());
        payload.put("requestedTokens", rateLimit.requestedTokens());
        payload.put("monitorWindowSeconds", monitor.windowSeconds());
        payload.put("emitIntervalSeconds", monitor.emitIntervalSeconds());
        return payload;
    }
}
