package com.zch.route;

public class RouteRuleDto {

    private String id;
    private String path;
    private String uri;
    private boolean rewriteEnabled = true;
    private String rewriteRegex;
    private String rewriteReplacement;
    private boolean circuitBreakerEnabled = true;
    private String circuitBreakerName;
    private String fallbackPath = "/fallback/default";

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public String getPath() {
        return path;
    }

    public void setPath(String path) {
        this.path = path;
    }

    public String getUri() {
        return uri;
    }

    public void setUri(String uri) {
        this.uri = uri;
    }

    public boolean isRewriteEnabled() {
        return rewriteEnabled;
    }

    public void setRewriteEnabled(boolean rewriteEnabled) {
        this.rewriteEnabled = rewriteEnabled;
    }

    public String getRewriteRegex() {
        return rewriteRegex;
    }

    public void setRewriteRegex(String rewriteRegex) {
        this.rewriteRegex = rewriteRegex;
    }

    public String getRewriteReplacement() {
        return rewriteReplacement;
    }

    public void setRewriteReplacement(String rewriteReplacement) {
        this.rewriteReplacement = rewriteReplacement;
    }

    public boolean isCircuitBreakerEnabled() {
        return circuitBreakerEnabled;
    }

    public void setCircuitBreakerEnabled(boolean circuitBreakerEnabled) {
        this.circuitBreakerEnabled = circuitBreakerEnabled;
    }

    public String getCircuitBreakerName() {
        return circuitBreakerName;
    }

    public void setCircuitBreakerName(String circuitBreakerName) {
        this.circuitBreakerName = circuitBreakerName;
    }

    public String getFallbackPath() {
        return fallbackPath;
    }

    public void setFallbackPath(String fallbackPath) {
        this.fallbackPath = fallbackPath;
    }
}

