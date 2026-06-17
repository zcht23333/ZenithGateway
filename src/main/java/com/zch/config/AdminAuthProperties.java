package com.zch.config;

import java.security.SecureRandom;
import java.util.HexFormat;
import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "zenith.admin")
public class AdminAuthProperties {

    /** 管理 API 共享密钥。为空时跳过认证（开发模式）。 */
    private String token = "";

    /** SSE 专用 token —— 启动时自动生成，作用域仅限 /monitor/stream，泄露不影响管理 API */
    private final String sseToken;

    private String tokenHeader = "Authorization";

    public AdminAuthProperties() {
        this.sseToken = generateSseToken();
    }

    public String getToken() {
        return token;
    }

    public void setToken(String token) {
        this.token = token;
    }

    public String getSseToken() {
        return sseToken;
    }

    public String getTokenHeader() {
        return tokenHeader;
    }

    public void setTokenHeader(String tokenHeader) {
        this.tokenHeader = tokenHeader;
    }

    public boolean isEnabled() {
        return token != null && !token.isBlank();
    }

    private static String generateSseToken() {
        byte[] bytes = new byte[32];
        new SecureRandom().nextBytes(bytes);
        return "sse_" + HexFormat.of().formatHex(bytes);
    }
}
