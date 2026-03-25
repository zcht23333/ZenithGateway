package com.zch.util;

import org.springframework.http.server.reactive.ServerHttpRequest;

public final class ClientIpResolver {

    private ClientIpResolver() {
    }

    public static String resolve(ServerHttpRequest request) {
        String xForwardedFor = request.getHeaders().getFirst("X-Forwarded-For");
        if (xForwardedFor != null && !xForwardedFor.isBlank()) {
            String first = xForwardedFor.split(",")[0].trim();
            if (!first.isBlank()) {
                return first;
            }
        }

        String xRealIp = request.getHeaders().getFirst("X-Real-IP");
        if (xRealIp != null && !xRealIp.isBlank()) {
            return xRealIp.trim();
        }

        if (request.getRemoteAddress() != null && request.getRemoteAddress().getAddress() != null) {
            return request.getRemoteAddress().getAddress().getHostAddress();
        }

        return "unknown";
    }
}

