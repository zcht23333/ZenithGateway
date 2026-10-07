package com.zch.util;

import com.zch.config.ProxyProperties;
import io.netty.util.NetUtil;
import java.util.ArrayList;
import java.util.List;
import org.springframework.http.server.reactive.ServerHttpRequest;
import org.springframework.stereotype.Component;

@Component
public final class ClientIpResolver {
    private final List<Subnet> trustedProxies;

    public ClientIpResolver(ProxyProperties properties) {
        trustedProxies = properties.getTrustedProxies().stream().map(Subnet::parse).toList();
    }

    public String resolve(ServerHttpRequest request) {
        var address = request.getRemoteAddress();
        if (address == null || address.getAddress() == null) {
            return "unknown";
        }
        String peer = address.getAddress().getHostAddress();
        if (!isTrusted(peer)) {
            return peer;
        }

        List<String> forwarded = request.getHeaders().get("X-Forwarded-For");
        if (forwarded != null) {
            String value = String.join(",", forwarded);
            if (value.length() > 2048) return peer;
            String[] hops = value.split(",", -1);
            if (hops.length > 32) return peer;
            List<String> ips = new ArrayList<>();
            for (String hop : hops) {
                String ip = hop.trim();
                if (!isIp(ip)) return peer;
                ips.add(ip);
            }
            // Walk from the directly connected proxy towards the client.
            String client = peer;
            for (int i = ips.size() - 1; i >= 0 && isTrusted(client); i--) {
                client = ips.get(i);
            }
            return canonical(client);
        }

        String realIp = request.getHeaders().getFirst("X-Real-IP");
        return realIp != null && isIp(realIp.trim()) ? canonical(realIp.trim()) : peer;
    }

    private boolean isTrusted(String ip) {
        if (!isIp(ip)) return false;
        byte[] bytes = NetUtil.createByteArrayFromIpAddressString(ip);
        return trustedProxies.stream().anyMatch(subnet -> subnet.contains(bytes));
    }

    private static boolean isIp(String value) {
        return NetUtil.isValidIpV4Address(value) || NetUtil.isValidIpV6Address(value);
    }

    private static String canonical(String value) {
        return NetUtil.bytesToIpAddress(NetUtil.createByteArrayFromIpAddressString(value));
    }

    private record Subnet(byte[] network, int bits) {
        static Subnet parse(String value) {
            String[] parts = value.trim().split("/", -1);
            if (parts.length > 2 || !isIp(parts[0])) {
                throw new IllegalArgumentException("Invalid trusted proxy IP/CIDR: " + value);
            }
            byte[] network = NetUtil.createByteArrayFromIpAddressString(parts[0]);
            int bits = parts.length == 1 ? network.length * 8 : Integer.parseInt(parts[1]);
            if (bits < 0 || bits > network.length * 8) {
                throw new IllegalArgumentException("Invalid trusted proxy CIDR: " + value);
            }
            return new Subnet(network, bits);
        }

        boolean contains(byte[] address) {
            if (address.length != network.length) return false;
            for (int i = 0; i < bits; i++) {
                int mask = 1 << (7 - i % 8);
                if ((address[i / 8] & mask) != (network[i / 8] & mask)) return false;
            }
            return true;
        }
    }
}
