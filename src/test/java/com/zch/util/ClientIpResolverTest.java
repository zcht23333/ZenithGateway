package com.zch.util;

import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.springframework.http.server.reactive.ServerHttpRequest;
import org.springframework.mock.http.server.reactive.MockServerHttpRequest;

class ClientIpResolverTest {

    @Test
    void shouldPreferXForwardedForFirstIp() {
        ServerHttpRequest request = MockServerHttpRequest.get("/proxy/test")
                .header("X-Forwarded-For", "203.0.113.10, 10.0.0.2")
                .build();

        String ip = ClientIpResolver.resolve(request);

        Assertions.assertEquals("203.0.113.10", ip);
    }

    @Test
    void shouldFallbackToXRealIp() {
        ServerHttpRequest request = MockServerHttpRequest.get("/proxy/test")
                .header("X-Real-IP", "198.51.100.25")
                .build();

        String ip = ClientIpResolver.resolve(request);

        Assertions.assertEquals("198.51.100.25", ip);
    }
}

