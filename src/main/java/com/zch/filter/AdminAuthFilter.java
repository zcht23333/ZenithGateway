package com.zch.filter;

import com.zch.config.AdminAuthProperties;
import java.nio.charset.StandardCharsets;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.Ordered;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.WebFilter;
import org.springframework.web.server.WebFilterChain;
import reactor.core.publisher.Mono;

/**
 * 管理 API 认证过滤器。
 *
 * 保护 /settings/**, /monitor/**, /dashboard/** 路径。
 * /monitor/stream 支持独立的 SSE token（通过 query parameter 传递），
 * 避免主 admin token 泄露在 URL 和日志中。
 */
@Component
public class AdminAuthFilter implements WebFilter, Ordered {

    private static final Logger log = LoggerFactory.getLogger(AdminAuthFilter.class);

    private static final List<String> PROTECTED_PREFIXES = List.of(
            "/settings", "/monitor", "/dashboard"
    );

    private static final String SSE_STREAM_PATH = "/monitor/stream";

    private final AdminAuthProperties authProperties;

    public AdminAuthFilter(AdminAuthProperties authProperties) {
        this.authProperties = authProperties;
        if (!authProperties.isEnabled()) {
            log.error("");
            log.error("╔══════════════════════════════════════════════════════════════════╗");
            log.error("║  ⚠  ADMIN TOKEN IS NOT CONFIGURED                              ║");
            log.error("║  All management endpoints (/settings, /monitor, /dashboard)    ║");
            log.error("║  are OPEN without authentication.                              ║");
            log.error("║  Set ZENITH_ADMIN_TOKEN environment variable to secure them.   ║");
            log.error("╚══════════════════════════════════════════════════════════════════╝");
            log.error("");
        } else {
            log.info("Admin API authentication ENABLED — SSE token scope is restricted to {}", SSE_STREAM_PATH);
        }
    }

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) {
        if (!authProperties.isEnabled()) {
            return chain.filter(exchange);
        }

        String path = exchange.getRequest().getURI().getPath();

        if (!isProtected(path)) {
            return chain.filter(exchange);
        }

        String presented = extractToken(exchange);
        String expected = authProperties.getToken();

        // 主 token 匹配 → 放行所有管理 API
        if (expected.equals(presented)) {
            return chain.filter(exchange);
        }

        // SSE token 仅限 /monitor/stream —— 防止泄露后扩大攻击面
        if (path.equals(SSE_STREAM_PATH) && authProperties.getSseToken().equals(presented)) {
            return chain.filter(exchange);
        }

        return writeUnauthorized(exchange);
    }

    @Override
    public int getOrder() {
        return -100;
    }

    private String extractToken(ServerWebExchange exchange) {
        // Authorization header（REST API 使用）
        String headerToken = exchange.getRequest().getHeaders().getFirst(authProperties.getTokenHeader());
        if (headerToken != null) {
            String trimmed = headerToken.trim();
            return trimmed.startsWith("Bearer ") ? trimmed.substring(7).trim() : trimmed;
        }

        // Query parameter（SSE EventSource 使用）
        String queryToken = exchange.getRequest().getQueryParams().getFirst("token");
        return queryToken != null ? queryToken.trim() : "";
    }

    private boolean isProtected(String path) {
        for (String prefix : PROTECTED_PREFIXES) {
            if (path.startsWith(prefix)) {
                return true;
            }
        }
        return false;
    }

    private Mono<Void> writeUnauthorized(ServerWebExchange exchange) {
        exchange.getResponse().setStatusCode(HttpStatus.UNAUTHORIZED);
        exchange.getResponse().getHeaders().setContentType(MediaType.APPLICATION_JSON);
        String body = "{\"code\":401,\"message\":\"Missing or invalid admin token\"}";
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        return exchange.getResponse().writeWith(
                Mono.just(exchange.getResponse().bufferFactory().wrap(bytes)));
    }
}
