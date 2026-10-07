package com.zch.config;

import java.security.SecureRandom;
import java.util.HexFormat;
import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "zenith.admin")
public class AdminAuthProperties {
    private String token = "";
    private String metricsToken = "";
    private String tokenHeader = "Authorization";
    private final String sseToken;

    public AdminAuthProperties() {
        byte[] bytes = new byte[32];
        new SecureRandom().nextBytes(bytes);
        sseToken = "sse_" + HexFormat.of().formatHex(bytes);
    }

    public String getToken() { return token; }
    public void setToken(String token) { this.token = token; }
    public String getTokenHeader() { return tokenHeader; }
    public void setTokenHeader(String tokenHeader) { this.tokenHeader = tokenHeader; }
    public String getMetricsToken() { return metricsToken; }
    public void setMetricsToken(String token) { metricsToken = token; }
    public String getSseToken() { return sseToken; }
    public boolean isEnabled() { return token != null && !token.isBlank(); }
}
