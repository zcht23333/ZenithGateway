package com.zch.util;

import com.zch.config.ProxyProperties;
import java.net.InetSocketAddress;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.mock.http.server.reactive.MockServerHttpRequest;
import static org.junit.jupiter.api.Assertions.*;

class ClientIpResolverTest {
    private ClientIpResolver resolver(String... trusted) {
        ProxyProperties properties = new ProxyProperties();
        properties.setTrustedProxies(List.of(trusted));
        return new ClientIpResolver(properties);
    }
    private MockServerHttpRequest request(String peer, String forwarded) {
        return MockServerHttpRequest.get("/test").remoteAddress(new InetSocketAddress(peer, 1234))
                .header("X-Forwarded-For", forwarded).build();
    }

    @Test
    void ignoresSpoofedHeadersFromUntrustedPeer() {
        assertEquals("203.0.113.8", resolver().resolve(request("203.0.113.8", "1.2.3.4")));
    }
    @Test
    void walksTrustedChainFromRightToLeft() {
        assertEquals("203.0.113.8", resolver("10.0.0.0/8")
                .resolve(request("10.0.0.1", "1.2.3.4, 203.0.113.8, 10.1.0.2")));
    }
    @Test
    void doesNotTrustLeftmostHeaderBeyondUntrustedHop() {
        assertEquals("192.0.2.5", resolver("10.0.0.1")
                .resolve(request("10.0.0.1", "203.0.113.8, 192.0.2.5")));
    }
    @Test
    void malformedChainFallsBackToPeer() {
        assertEquals("10.0.0.1", resolver("10.0.0.0/8")
                .resolve(request("10.0.0.1", "203.0.113.8, bad-hostname")));
        assertEquals("10.0.0.1", resolver("10.0.0.0/8").resolve(request("10.0.0.1", ",")));
    }
    @Test
    void trustsIpv6CidrAndCanonicalizesClient() {
        assertEquals("2001:db8:1::9", resolver("2001:db8:2::/64")
                .resolve(request("2001:db8:2::1", "2001:0db8:0001::9")));
    }
    @Test
    void realIpIsOnlyUsedForTrustedPeer() {
        var request = MockServerHttpRequest.get("/test").remoteAddress(new InetSocketAddress("10.0.0.1", 1234))
                .header("X-Real-IP", "203.0.113.8").build();
        assertEquals("10.0.0.1", resolver().resolve(request));
        assertEquals("203.0.113.8", resolver("10.0.0.0/8").resolve(request));
    }
    @Test
    void rejectsInvalidProxyConfiguration() {
        assertThrows(IllegalArgumentException.class, () -> resolver("example.com"));
        assertThrows(IllegalArgumentException.class, () -> resolver("10.0.0.1/33"));
    }
}
