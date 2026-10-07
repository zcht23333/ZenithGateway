package com.zch.route;
import com.zch.proxy.ProxyResilienceFilter;
import java.net.URI;
import java.util.*;
import org.springframework.cloud.gateway.config.GatewayProperties;
import org.springframework.cloud.gateway.filter.FilterDefinition;
import org.springframework.cloud.gateway.filter.factory.GatewayFilterFactory;
import org.springframework.cloud.gateway.handler.predicate.PredicateDefinition;
import org.springframework.cloud.gateway.handler.predicate.RoutePredicateFactory;
import org.springframework.cloud.gateway.route.*;
import org.springframework.cloud.gateway.support.ConfigurationService;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Flux;

@Component
public class RouteCompiler {
    public static final String VERSION="zenith.route.version";
    private final List<RoutePredicateFactory> predicates;private final List<GatewayFilterFactory> filters;
    private final ConfigurationService configuration;private final GatewayProperties properties;
    public RouteCompiler(List<RoutePredicateFactory> predicates,List<GatewayFilterFactory> filters,ConfigurationService configuration,GatewayProperties properties){
        this.predicates=predicates;this.filters=filters;this.configuration=configuration;this.properties=properties;
        if(properties.isRouteFilterCacheEnabled())throw new IllegalArgumentException("Versioned routes require route-filter-cache-enabled=false");
        if(!properties.getRoutes().isEmpty())throw new IllegalArgumentException("Versioned routes require a single authoritative Redis source; migrate static routes first");
    }
    public List<Route> compile(RouteSnapshot snapshot){
        GatewayProperties strict=new GatewayProperties();strict.setFailOnRouteDefinitionError(true);strict.setDefaultFilters(properties.getDefaultFilters());
        var definitions=snapshot.routes().stream().map(r->definition(r,snapshot.version())).toList();
        var locator=new RouteDefinitionRouteLocator(()->Flux.fromIterable(definitions),predicates,filters,strict,configuration);
        var built=locator.getRoutes().collectList().block();
        if(built==null||built.size()!=definitions.size())throw new IllegalStateException("Incomplete route build");
        return List.copyOf(built);
    }
    static RouteDefinition definition(RouteSnapshot.Rule route,String version){
        RouteDefinition d=new RouteDefinition();d.setId(route.id());d.setUri(URI.create(route.uri()));
        PredicateDefinition path=new PredicateDefinition();path.setName("Path");path.addArg("pattern",route.path());d.getPredicates().add(path);
        if(route.rewriteEnabled()){
            FilterDefinition f=new FilterDefinition();f.setName("RewritePath");
            var args=new LinkedHashMap<String,String>();args.put("regexp",route.rewriteRegex());args.put("replacement",route.rewriteReplacement());f.setArgs(args);d.getFilters().add(f);
        }
        d.getMetadata().put(ProxyResilienceFilter.ENABLED,route.circuitBreakerEnabled());d.getMetadata().put(ProxyResilienceFilter.NAME,route.circuitBreakerName());d.getMetadata().put(VERSION,version);return d;
    }
}
