package com.zch.filter;

import com.zch.config.AdminAuthProperties;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.Ordered;
import org.springframework.core.env.Environment;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.WebFilter;
import org.springframework.web.server.WebFilterChain;
import org.springframework.web.util.pattern.PathPattern;
import org.springframework.web.util.pattern.PathPatternParser;
import reactor.core.publisher.Mono;

@Component
public class AdminAuthFilter implements WebFilter, Ordered {
    private static final Logger log = LoggerFactory.getLogger(AdminAuthFilter.class);
    private static final List<PathPattern> PROTECTED_PATHS =
            List.of("/settings/**", "/monitor/**", "/dashboard/**", "/actuator/**")
                    .stream().map(PathPatternParser.defaultInstance::parse).toList();
    private static final List<PathPattern> HEALTH_PATHS = List.of("/actuator/health", "/actuator/health/liveness", "/actuator/health/readiness")
            .stream().map(PathPatternParser.defaultInstance::parse).toList();
    private static final PathPattern PROMETHEUS = PathPatternParser.defaultInstance.parse("/actuator/prometheus");
    private final AdminAuthProperties properties;

    public AdminAuthFilter(AdminAuthProperties properties, Environment environment) {
        this.properties = properties;
        if (!properties.isEnabled()) {
            if (!environment.matchesProfiles("dev") || environment.matchesProfiles("prod")) {
                throw new IllegalStateException("ZENITH_ADMIN_TOKEN is required outside the explicit dev profile");
            }
            log.warn("Development mode: management authentication is disabled");
        }
    }

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) {
        var path = exchange.getRequest().getPath().pathWithinApplication();
        // Includes binding/auth/readiness failures before the runtime controller can set its headers.
        if (path.value().startsWith("/settings/lifecycle") || path.value().equals("/settings/runtime") || path.value().startsWith("/settings/runtime/") || path.value().startsWith("/settings/proxy/") || path.value().startsWith("/settings/rate-limit/"))
            exchange.getResponse().getHeaders().setCacheControl("no-store");

        // The administrative credential is accepted only in a header, never in a URL.
        String header = exchange.getRequest().getHeaders().getFirst(properties.getTokenHeader());
        String credential = header == null ? "" : header.trim();
        if (credential.startsWith("Bearer ")) {
            credential = credential.substring(7).trim();
        }
        if (PROMETHEUS.matches(path)) {
            String scrape = exchange.getRequest().getHeaders().getFirst("Authorization");
            String scrapeCredential = scrape != null && scrape.startsWith("Bearer ") ? scrape.substring(7).trim() : null;
            if (matches(properties.getToken(), credential) || matches(properties.getMetricsToken(), scrapeCredential)) {
                return chain.filter(exchange);
            }
            return unauthorized(exchange);
        }
        if (!properties.isEnabled() || HEALTH_PATHS.stream().anyMatch(p -> p.matches(path))
                || PROTECTED_PATHS.stream().noneMatch(p -> p.matches(path))) {
            return chain.filter(exchange);
        }
        if (matches(properties.getToken(), credential)) {
            return chain.filter(exchange);
        }

        if ("/monitor/stream".equals(path.value())) {
            String sseToken = exchange.getRequest().getQueryParams().getFirst("token");
            if (matches(properties.getSseToken(), sseToken)) {
                return chain.filter(exchange);
            }
        }

        return unauthorized(exchange);
    }

    private Mono<Void> unauthorized(ServerWebExchange exchange) {
        exchange.getResponse().setStatusCode(HttpStatus.UNAUTHORIZED);
        exchange.getResponse().getHeaders().setContentType(MediaType.APPLICATION_JSON);
        exchange.getResponse().getHeaders().setCacheControl("no-store");
        byte[] body = "{\"code\":401,\"message\":\"Missing or invalid admin token\"}"
                .getBytes(StandardCharsets.UTF_8);
        return exchange.getResponse().writeWith(Mono.just(exchange.getResponse().bufferFactory().wrap(body)));
    }

    private boolean matches(String expected, String actual) {
        return expected != null && !expected.isBlank() && actual != null && MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8),
                actual.getBytes(StandardCharsets.UTF_8));
    }

    @Override
    public int getOrder() { return -100; }
}
