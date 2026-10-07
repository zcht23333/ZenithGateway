package com.zch.route;

import com.zch.config.RuntimeConfigSyncProperties;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.Supplier;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.DisposableBean;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.ApplicationListener;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Mono;
import tools.jackson.databind.json.JsonMapper;

@Service
public class DynamicRouteService implements ApplicationRunner,ApplicationListener<ApplicationReadyEvent>,DisposableBean {
    private final RouteStore store;private final RouteCompiler compiler;private final ActiveRoutes active;
    private final RoutePublicationProperties options;private final String instanceId;private final JsonMapper mapper;
    private final ThreadPoolExecutor management=new ThreadPoolExecutor(1,1,0,TimeUnit.MILLISECONDS,new ArrayBlockingQueue<>(16),r->{var t=new Thread(r,"route-management");t.setDaemon(true);return t;},new ThreadPoolExecutor.AbortPolicy());
    private final ScheduledExecutorService sync=Executors.newSingleThreadScheduledExecutor(r->{var t=new Thread(r,"route-sync");t.setDaemon(true);return t;});
    private volatile boolean closed,started,checking;private ScheduledFuture<?> task;
    private RouteSnapshot observed;private Instant observedAt,lastCheckAt;private long confirmedNanos,checks,failures;
    private String reasonCode,reason;private String lastOutcome="pending";
    public DynamicRouteService(RouteStore store,RouteCompiler compiler,ActiveRoutes active,RoutePublicationProperties options,RuntimeConfigSyncProperties identity,JsonMapper mapper){
        this.store=store;this.compiler=compiler;this.active=active;this.options=options;this.instanceId=identity.getInstanceId();this.mapper=mapper;options.validate();
    }
    @Override public void run(ApplicationArguments args){
        // ApplicationRunner completes before Boot reports readiness. Failure aborts startup.
        var value=store.read(true,true).snapshot();observe(value);apply(value);
    }
    @Override public synchronized void onApplicationEvent(ApplicationReadyEvent event){
        if(started||closed)return;started=true;task=sync.scheduleWithFixedDelay(this::check,0,options.getIntervalMs(),TimeUnit.MILLISECONDS);
    }
    void check(){
        if(closed||checking)return;checking=true;
        try{var value=store.read(false,true).snapshot();observe(value);apply(value);
            synchronized(this){lastOutcome="ok";reasonCode=null;reason=null;}}
        catch(Exception error){synchronized(this){failures++;lastOutcome="failed";reasonCode=error instanceof RouteProblem p?String.valueOf(p.response().get("code")):"ROUTE_BUILD_FAILED";
            reason=error instanceof RouteProblem?error.getMessage():"完整路由构建失败；保留上一份实际生效路由";}}
        finally{synchronized(this){checks++;lastCheckAt=Instant.now();checking=false;}}
    }
    private synchronized void observe(RouteSnapshot value){
        if(closed)return;
        // A delayed lower observation cannot make the diagnostic authority version move backwards either.
        if(observed!=null&&observed.epoch().equals(value.epoch())&&observed.revision()>value.revision())return;
        observed=value;observedAt=Instant.now();confirmedNanos=System.nanoTime();
    }
    private void apply(RouteSnapshot value){
        var current=active.current();
        if(current!=null&&current.snapshot().equals(value))return;
        if(current!=null&&current.snapshot().epoch().equals(value.epoch())&&current.snapshot().revision()>value.revision())return;
        var built=compiler.compile(value);
        synchronized(this){if(!closed)active.adopt(value,built);}
    }
    public Mono<Map<String,Object>> read(){return submit(()->{
        var snapshot=store.read(false,false).snapshot();observe(snapshot);
        var body=new LinkedHashMap<String,Object>();body.put("source","redis");body.put("snapshot",snapshot);body.put("version",snapshot.version());body.put("routes",snapshot.routes());body.putAll(adoption(snapshot));return body;
    });}
    public Mono<Map<String,Object>> save(String expected,RouteRuleDto input){return change(expected,input,null);}
    public Mono<Map<String,Object>> delete(String expected,String id){return change(expected,null,id);}
    private Mono<Map<String,Object>> change(String expected,RouteRuleDto input,String deleteId){return Mono.defer(()->{
        requireVersion(expected);
        RouteRuleDto normalized=deleteId==null?RouteValidator.normalize(input):null;
        return submit(()->{
            final RouteStore.Stored base;
            try{base=store.read(false,false);}catch(RouteProblem error){throw new RouteProblem(error.status(),String.valueOf(error.response().get("code")),"not-written",error.getMessage());}
            observe(base.snapshot());
            if(!base.snapshot().version().equals(expected))throw conflict(base.snapshot());
            var candidate=base.snapshot().change(normalized,deleteId);candidate.json(mapper);
            final java.util.List<org.springframework.cloud.gateway.route.Route> built;
            try{built=compiler.compile(candidate);}catch(Exception error){throw new RouteProblem(422,"ROUTE_BUILD_REJECTED","not-written","整份路由构建失败，未发布任何修改");}
            var confirmed=store.publish(base,candidate).snapshot();observe(confirmed);
            String adoptionError=null;
            try{synchronized(this){if(!closed)active.adopt(confirmed,built);}}
            catch(Exception error){adoptionError=error.getMessage();}
            var response=new LinkedHashMap<String,Object>();response.put("outcome","committed");response.put("version",confirmed.version());response.put("snapshot",confirmed);response.put("routes",confirmed.routes());response.putAll(adoption(confirmed));
            response.put("adoptionIssue",adoptionError);response.put("message","存储已提交；其他实例异步采用，不能据此确认全体实例已生效");return response;
        });
    });}
    static void requireVersion(String expected){
        if(expected==null||expected.isBlank())throw new RouteProblem(428,"ROUTE_EXPECTED_VERSION_REQUIRED","not-written","提交路由必须携带核对时的 expectedVersion；旧调用端需要升级");
        try{RouteSnapshot.revision(expected);}catch(Exception error){throw new RouteValidationException("expectedVersion","路由版本格式非法");}
    }
    private RouteProblem conflict(RouteSnapshot current){return new RouteProblem(409,"ROUTE_VERSION_CONFLICT","not-written","路由已被其他提交更新，请核对当前值与草稿后明确再次提交").detail("current",current);}
    private Map<String,Object> adoption(RouteSnapshot requested){
        var p=active.current();var out=new LinkedHashMap<String,Object>();out.put("instanceId",instanceId);out.put("adoptedVersion",p==null?null:p.snapshot().version());
        out.put("adoption",p==null?"pending":p.snapshot().equals(requested)?"adopted":p.snapshot().epoch().equals(requested.epoch())&&p.snapshot().revision()>requested.revision()?"newer":"pending");return out;
    }
    public Map<String,Object> adopted(){var p=active.current();var out=new LinkedHashMap<String,Object>();out.put("source","local-forwarding");out.put("instanceId",instanceId);out.put("version",p==null?null:p.snapshot().version());out.put("routes",p==null?null:p.snapshot().routes());out.put("adoptedAt",p==null?null:p.adoptedAt().toString());return out;}
    public synchronized Map<String,Object> diagnostics(){
        var p=active.current();Long age=observedAt==null?null:Math.max(0,TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-confirmedNanos));
        boolean stale=age==null||age>options.getStaleAfterMs(),matches=p!=null&&p.snapshot().equals(observed);
        var body=new LinkedHashMap<String,Object>();body.put("source","local");body.put("instanceId",instanceId);body.put("status",closed?"stopped":stale?"stale":"failed".equals(lastOutcome)?"failed":matches?"ok":"pending");
        body.put("adoptedVersion",p==null?null:p.snapshot().version());body.put("routeCount",p==null?null:p.routes().size());body.put("lastAdoptedAt",p==null?null:p.adoptedAt().toString());
        body.put("lastObservedVersion",observed==null?null:observed.version());body.put("lastObservedAt",observedAt==null?null:observedAt.toString());body.put("confirmationAgeMs",age);body.put("stale",stale);body.put("matchesLastObservation",matches);
        body.put("reasonCode",reasonCode);body.put("reason",reason);body.put("lastCheckAt",lastCheckAt==null?null:lastCheckAt.toString());body.put("lastCheckOutcome",lastOutcome);
        body.put("checking",checking);body.put("checks",checks);body.put("failures",failures);body.put("intervalMs",options.getIntervalMs());body.put("timeoutMs",options.getTimeoutMs());body.put("staleAfterMs",options.getStaleAfterMs());
        body.put("managementQueueSize",management.getQueue().size());body.put("managementQueueCapacity",16);body.put("managementActive",management.getActiveCount());body.put("resources",store.resources());return body;
    }
    private <T> Mono<T> submit(Supplier<T> work){return Mono.create(sink->{
        var cancelled=new java.util.concurrent.atomic.AtomicBoolean();
        Runnable job=()->{if(cancelled.get())return;try{if(closed)throw new IllegalStateException("Route service stopped");sink.success(work.get());}catch(Throwable error){sink.error(error);}};
        sink.onCancel(()->{cancelled.set(true);management.remove(job);});
        try{if(closed)throw new RejectedExecutionException();management.execute(job);}catch(RejectedExecutionException error){sink.error(new RouteProblem(503,"ROUTE_MANAGEMENT_BUSY","not-written","路由管理任务已满或正在关闭，请稍后重新核对"));}
    });}
    @Override public void destroy(){synchronized(this){if(closed)return;closed=true;if(task!=null)task.cancel(true);}sync.shutdownNow();management.shutdown();
        try{sync.awaitTermination(2,TimeUnit.SECONDS);if(!management.awaitTermination(3,TimeUnit.SECONDS))management.shutdownNow();}catch(InterruptedException e){Thread.currentThread().interrupt();management.shutdownNow();}
        LoggerFactory.getLogger(getClass()).info("Route publication stopped; syncTerminated={}, managementTerminated={}, queued={}",sync.isTerminated(),management.isTerminated(),management.getQueue().size());}
}
