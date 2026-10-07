package com.zch.route;

import java.net.URI;
import java.util.Locale;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.web.util.pattern.PathPatternParser;

final class RouteValidator {
    private RouteValidator() { }

    static RouteRuleDto normalize(RouteRuleDto input) {
        if (input == null) throw invalid("route", "Route body is required");
        limit("id", input.getId(), 100);
        limit("path", input.getPath(), 1024); limit("uri", input.getUri(), 2048);
        limit("rewriteRegex", input.getRewriteRegex(), 2048); limit("rewriteReplacement", input.getRewriteReplacement(), 2048);
        limit("circuitBreakerName", input.getCircuitBreakerName(), 200); limit("fallbackPath", input.getFallbackPath(), 128);
        RouteRuleDto route = new RouteRuleDto();
        String id = text(input.getId());
        if (id == null) id = "route-" + UUID.randomUUID();
        if (!id.matches("[A-Za-z0-9][A-Za-z0-9._-]{0,99}")) {
            throw invalid("id", "id must contain 1-100 letters, digits, dots, underscores or hyphens");
        }
        route.setId(id);
        String path = text(input.getPath());
        if (path == null || !path.startsWith("/") || path.startsWith("//") || path.contains("?")
                || path.contains("#") || path.chars().anyMatch(Character::isWhitespace)) {
            throw invalid("path", "path must be an absolute path pattern, for example /api/**");
        }
        try {
            PathPatternParser.defaultInstance.parse(path);
        } catch (IllegalArgumentException error) {
            throw invalid("path", "Invalid path pattern");
        }
        route.setPath(path);
        String target = text(input.getUri());
        try {
            URI uri = target == null ? null : URI.create(target);
            if (uri == null || uri.getScheme() == null
                    || !java.util.Set.of("http", "https").contains(uri.getScheme().toLowerCase(Locale.ROOT))
                    || uri.getHost() == null || uri.getRawUserInfo() != null
                    || uri.getRawQuery() != null || uri.getRawFragment() != null
                    || uri.getPort() == 0 || uri.getPort() > 65535) {
                throw new IllegalArgumentException();
            }
        } catch (IllegalArgumentException error) {
            throw invalid("uri", "uri must be a valid http(s) address without credentials, query or fragment");
        }
        route.setUri(target);
        route.setRewriteEnabled(input.isRewriteEnabled());
        String regex = text(input.getRewriteRegex());
        String replacement = input.getRewriteReplacement();
        if (input.isRewriteEnabled()) {
            if (regex == null) {
                if (!path.endsWith("/**")) {
                    throw invalid("rewriteRegex", "rewriteRegex is required unless path ends in /**");
                }
                String prefix = path.substring(0, path.length() - 3);
                regex = "^" + Pattern.quote(prefix) + "/(?<segment>.*)$";
            }
            Pattern pattern;
            try {
                pattern = Pattern.compile(regex);
            } catch (IllegalArgumentException error) {
                throw invalid("rewriteRegex", "Invalid rewrite regular expression");
            }
            if (replacement == null) replacement = "/${segment}";
            validateReplacement(pattern, replacement);
        }
        route.setRewriteRegex(regex);
        route.setRewriteReplacement(replacement);
        route.setCircuitBreakerEnabled(input.isCircuitBreakerEnabled());
        String breaker = text(input.getCircuitBreakerName());
        route.setCircuitBreakerName(breaker == null ? "cb-" + id : breaker);
        String fallback = text(input.getFallbackPath());
        if (fallback == null) fallback = "/fallback/default";
        if (input.isCircuitBreakerEnabled() && !"/fallback/default".equals(fallback)) {
            throw invalid("fallbackPath", "Only the implemented /fallback/default endpoint is supported");
        }
        route.setFallbackPath(fallback);
        return route;
    }

    // Validate Java Matcher replacement syntax even when no sample path matches the regex.
    private static void validateReplacement(Pattern pattern, String value) {
        if (!value.startsWith("/") || value.startsWith("//") || value.contains("\r") || value.contains("\n")) {
            throw invalid("rewriteReplacement", "rewriteReplacement must start with a single /");
        }
        int groups = pattern.matcher("").groupCount();
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == '\\') {
                if (++i == value.length()) throw invalid("rewriteReplacement", "Trailing escape in replacement");
            } else if (c == '$') {
                if (++i == value.length()) throw invalid("rewriteReplacement", "Missing replacement group");
                c = value.charAt(i);
                if (c == '{') {
                    int end = value.indexOf('}', i + 1);
                    if (end < 0 || !pattern.namedGroups().containsKey(value.substring(i + 1, end))) {
                        throw invalid("rewriteReplacement", "Replacement references an unknown named group");
                    }
                    i = end;
                } else if (c >= '0' && c <= '9') {
                    int group = c - '0';
                    if (group > groups) throw invalid("rewriteReplacement", "Replacement references an unknown group");
                    while (i + 1 < value.length() && value.charAt(i + 1) >= '0' && value.charAt(i + 1) <= '9') {
                        int next = group * 10 + value.charAt(i + 1) - '0';
                        if (next > groups) break;
                        group = next;
                        i++;
                    }
                } else {
                    throw invalid("rewriteReplacement", "Invalid replacement group syntax");
                }
            }
        }
    }

    private static void limit(String field,String value,int max) {
        if(value!=null && value.length()>max)throw invalid(field,field+" exceeds "+max+" characters");
    }
    private static String text(String value) {
        return value == null || value.isBlank() ? null : value.trim();
    }
    private static RouteValidationException invalid(String field, String message) {
        return new RouteValidationException(field, message);
    }
}
