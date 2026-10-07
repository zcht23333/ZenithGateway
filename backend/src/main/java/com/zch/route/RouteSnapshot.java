package com.zch.route;

import java.nio.charset.StandardCharsets;
import java.util.*;
import tools.jackson.databind.json.JsonMapper;

/** Immutable management and forwarding identity; entirely independent of runtime configuration. */
public record RouteSnapshot(int schemaVersion, String version, List<Rule> routes) {
    public static final int MAX_ROUTES=256, MAX_BYTES=262144;
    public static final long MAX_REVISION=9_007_199_254_740_991L;
    public RouteSnapshot {
        if (schemaVersion!=1) throw new IllegalArgumentException("Unsupported route schema");
        revision(version); routes=List.copyOf(routes);
        if (routes.size()>MAX_ROUTES) throw new RouteValidationException("routes","最多允许 256 条路由");
        if (routes.stream().map(Rule::id).distinct().count()!=routes.size()) throw new IllegalArgumentException("Duplicate route ID");
        if (!routes.equals(routes.stream().sorted(Comparator.comparing(Rule::id)).toList())) throw new IllegalArgumentException("Routes must be ordered by ID");
    }
    public static long revision(String version) {
        if (version==null || !version.matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[1-9][0-9]{0,15}"))
            throw new IllegalArgumentException("Invalid route version");
        long n=Long.parseLong(version.substring(37));
        if (n>MAX_REVISION) throw new IllegalArgumentException("Route revision exhausted");
        return n;
    }
    public String epoch(){return version.substring(0,36);}
    public long revision(){return revision(version);}
    public static RouteSnapshot empty(){return new RouteSnapshot(1,UUID.randomUUID()+":1",List.of());}
    public RouteSnapshot change(RouteRuleDto input,String deleteId) {
        if(revision()==MAX_REVISION)throw new RouteProblem(409,"ROUTE_VERSION_EXHAUSTED","not-written","路由版本已用尽，需要受控迁移");
        var next=new TreeMap<String,Rule>();routes.forEach(r->next.put(r.id(),r));
        if(deleteId!=null) {
            if(next.remove(deleteId)==null)throw new RouteProblem(404,"ROUTE_NOT_FOUND","not-written","目标路由已不存在，请重新读取并核对");
        } else {var r=Rule.from(input);next.put(r.id(),r);}
        return new RouteSnapshot(1,epoch()+":"+(revision()+1),List.copyOf(next.values()));
    }
    public String json(JsonMapper mapper) {
        String json=mapper.writeValueAsString(this);
        if(json.getBytes(StandardCharsets.UTF_8).length>MAX_BYTES)throw new RouteValidationException("routes","完整路由快照超过 256 KiB");
        return json;
    }
    public static RouteSnapshot parse(String raw,JsonMapper mapper) {
        if(raw==null || raw.getBytes(StandardCharsets.UTF_8).length>MAX_BYTES)throw new IllegalArgumentException("Invalid route snapshot size");
        var root=mapper.readTree(raw);
        if(!root.isObject() || !root.path("schemaVersion").isInt() || root.path("schemaVersion").asInt()!=1
                || !root.path("version").isString() || !root.path("routes").isArray())throw new IllegalArgumentException("Invalid route snapshot structure");
        List<Rule> rules=new ArrayList<>();
        for(var node:root.path("routes")) {
            if(!node.isObject())throw new IllegalArgumentException("Invalid route object");
            for(String field:List.of("id","path","uri","circuitBreakerName","fallbackPath"))
                if(!node.path(field).isString())throw new IllegalArgumentException("Missing route field "+field);
            for(String field:List.of("rewriteRegex","rewriteReplacement"))
                if(!node.has(field) || !(node.path(field).isString() || node.path(field).isNull()))throw new IllegalArgumentException("Invalid route field "+field);
            for(String field:List.of("rewriteEnabled","circuitBreakerEnabled"))
                if(!node.path(field).isBoolean())throw new IllegalArgumentException("Invalid route switch "+field);
            if(node.path("id").asString().isBlank())throw new IllegalArgumentException("Stored route ID required");
            Rule normalized=Rule.from(mapper.treeToValue(node,RouteRuleDto.class));
            if(!mapper.valueToTree(normalized).equals(node))throw new IllegalArgumentException("Stored route must be canonical; migration required");
            rules.add(normalized);
        }
        return new RouteSnapshot(1,root.path("version").asString(),rules);
    }
    public record Rule(String id,String path,String uri,boolean rewriteEnabled,String rewriteRegex,String rewriteReplacement,
                       boolean circuitBreakerEnabled,String circuitBreakerName,String fallbackPath) {
        static Rule from(RouteRuleDto dto){var r=RouteValidator.normalize(dto);return new Rule(r.getId(),r.getPath(),r.getUri(),r.isRewriteEnabled(),r.getRewriteRegex(),r.getRewriteReplacement(),r.isCircuitBreakerEnabled(),r.getCircuitBreakerName(),r.getFallbackPath());}
        RouteRuleDto dto(){var d=new RouteRuleDto();d.setId(id);d.setPath(path);d.setUri(uri);d.setRewriteEnabled(rewriteEnabled);d.setRewriteRegex(rewriteRegex);d.setRewriteReplacement(rewriteReplacement);d.setCircuitBreakerEnabled(circuitBreakerEnabled);d.setCircuitBreakerName(circuitBreakerName);d.setFallbackPath(fallbackPath);return d;}
    }
}
