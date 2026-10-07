package com.zch.route;
import java.time.Instant;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;
import org.springframework.cloud.gateway.route.Route;
import org.springframework.cloud.gateway.route.RouteLocator;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Flux;

/** The same atomic value owns the diagnostic version AND the actual matching routes. */
@Component
public class ActiveRoutes implements RouteLocator {
    public record Publication(RouteSnapshot snapshot,List<Route> routes,Instant adoptedAt){public Publication{routes=List.copyOf(routes);}}
    private final AtomicReference<Publication> active=new AtomicReference<>();
    public Publication current(){return active.get();}
    public Publication adopt(RouteSnapshot snapshot,List<Route> routes) {
        if(routes.size()!=snapshot.routes().size())throw new IllegalStateException("Incomplete route build");
        var next=new Publication(snapshot,routes,Instant.now());
        for(;;){
            var old=active.get();
            if(old!=null){
                if(!old.snapshot().epoch().equals(snapshot.epoch()))throw new RouteProblem(503,"ROUTE_GENERATION_CHANGED","not-applicable","路由世代变化；保留当前路由，需要受控重启");
                if(old.snapshot().version().equals(snapshot.version())){
                    if(!old.snapshot().equals(snapshot))throw new RouteProblem(503,"ROUTE_VERSION_CONTENT_MISMATCH","not-applicable","同版本路由内容不同；保留当前路由");
                    return old;
                }
                if(old.snapshot().revision()>snapshot.revision())return old;
            }
            if(active.compareAndSet(old,next))return next;
        }
    }
    // Gateway introspects during context refresh, before runners. No publication exists yet;
    // ReadinessFilter rejects business traffic until the startup read/build has succeeded.
    @Override public Flux<Route> getRoutes(){return Flux.defer(()->{var p=active.get();return p==null?Flux.empty():Flux.fromIterable(p.routes());});}
}
