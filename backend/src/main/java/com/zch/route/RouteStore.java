package com.zch.route;

import com.zch.config.GatewayRuntimeProperties;
import com.zch.config.RuntimeConfigSyncProperties;
import io.lettuce.core.*;
import io.lettuce.core.api.StatefulRedisConnection;
import io.lettuce.core.codec.StringCodec;
import io.lettuce.core.resource.DefaultClientResources;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.springframework.beans.factory.DisposableBean;
import org.springframework.boot.data.redis.autoconfigure.DataRedisProperties;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;
import tools.jackson.databind.json.JsonMapper;

/** Two owned, serial I/O lanes. No reconnect buffer, command replay or unbounded connection creation. */
@Component
public class RouteStore implements DisposableBean {
    public record Stored(String raw,RouteSnapshot snapshot){}
    private final JsonMapper mapper;private final String key,script;private final RoutePublicationProperties options;
    private final DefaultClientResources resources;private final Link management,background;
    public RouteStore(DataRedisProperties redis,GatewayRuntimeProperties runtime,RuntimeConfigSyncProperties identity,
                      RoutePublicationProperties options,JsonMapper mapper) throws Exception {
        options.validate();this.options=options;this.mapper=mapper;key=runtime.getRoute().getRedisKey();
        if(redis.getSentinel()!=null||redis.getCluster()!=null||redis.getMasterreplica()!=null)throw new IllegalArgumentException("Versioned routes require standalone Redis");
        script=new ClassPathResource("route-publication.lua").getContentAsString(java.nio.charset.StandardCharsets.UTF_8);
        resources=DefaultClientResources.builder().ioThreadPoolSize(2).computationThreadPoolSize(2).build();
        management=new Link(uri(redis,"zenith-route-management:"+identity.getInstanceId()));
        background=new Link(uri(redis,"zenith-route-sync:"+identity.getInstanceId()));
    }
    private RedisURI uri(DataRedisProperties redis,String name){
        var uri=redis.getUrl()==null?RedisURI.create(redis.getHost(),redis.getPort()):RedisURI.create(redis.getUrl());
        if(redis.getUrl()==null){uri.setDatabase(redis.getDatabase());uri.setSsl(redis.getSsl().isEnabled());
            if(redis.getUsername()!=null)uri.setAuthentication(redis.getUsername(),Objects.toString(redis.getPassword(),""));
            else if(redis.getPassword()!=null&&!redis.getPassword().isEmpty())uri.setAuthentication(redis.getPassword().toCharArray());}
        uri.setClientName(name);uri.setTimeout(Duration.ofMillis(options.getTimeoutMs()));return uri;
    }
    public Stored read(boolean boot,boolean sync){
        String initial=boot?RouteSnapshot.empty().json(mapper):"";
        return decode((sync?background:management).eval(false,boot?"boot":"read","","",initial),false);
    }
    public Stored publish(Stored base,RouteSnapshot candidate){
        return decode(management.eval(true,"write",base.snapshot().version(),base.raw(),candidate.json(mapper)),true);
    }
    private Stored decode(String json,boolean write){
        try {
            var reply=mapper.readTree(json);String status=reply.path("status").asString();
            String raw=reply.path("snapshot").isString()?reply.path("snapshot").asString():null;
            if("ok".equals(status)||"conflict".equals(status)||"changed".equals(status)){
                RouteSnapshot snapshot=RouteSnapshot.parse(raw,mapper);
                if(!"ok".equals(status))throw new RouteProblem(409,"ROUTE_VERSION_CONFLICT","not-written","路由已被更新，请保留草稿并核对当前快照后重新提交").detail("current",snapshot);
                return new Stored(raw,snapshot);
            }
            String message=switch(status){case "legacy"->"检测到旧 Redis Hash；需停写、备份并迁移后启动";case "missing"->"权威路由快照缺失，保留本地路由；不会自行重建";case "rejected"->"Redis 明确拒绝本次发布";default->"权威路由数据或世代标记损坏，保留本地路由";};
            throw new RouteProblem(503,"ROUTE_STORAGE_"+status.toUpperCase(Locale.ROOT),write?"not-written":"not-applicable",message);
        } catch(RouteProblem error){throw error;}catch(Exception error){throw new RouteProblem(503,"ROUTE_STORAGE_INVALID",write?"unknown":"not-applicable","未获得有效的完整路由确认；不采用异常数据");}
    }
    public Map<String,Object> resources(){return Map.of("management",management.status(),"sync",background.status(),"maximumPhysicalConnections",2,"maximumApplicationCommands",2);}
    @Override public void destroy(){management.close();background.close();resources.shutdown(0,1,TimeUnit.SECONDS);}

    private final class Link {
        private final RedisURI uri;private final RedisClient client;private volatile StatefulRedisConnection<String,String> connection;
        private volatile CompletableFuture<Void> retired=CompletableFuture.completedFuture(null);private volatile boolean closed;
        private final AtomicInteger commands=new AtomicInteger();private volatile long attempts,peakCommands;
        Link(RedisURI uri){this.uri=uri;client=RedisClient.create(resources,uri);
            var timeout=Duration.ofMillis(options.getTimeoutMs());
            client.setOptions(ClientOptions.builder().autoReconnect(false).requestQueueSize(8)
                .disconnectedBehavior(ClientOptions.DisconnectedBehavior.REJECT_COMMANDS)
                .socketOptions(SocketOptions.builder().connectTimeout(timeout).build()).build());}
        synchronized String eval(boolean write,String... args){
            boolean sent=false;long end=System.nanoTime()+TimeUnit.MILLISECONDS.toNanos(options.getTimeoutMs());
            try {
                if(closed||!retired.isDone()||retired.isCompletedExceptionally())throw new IllegalStateException("Previous connection has not closed");
                if(connection==null||!connection.isOpen()){
                    if(connection!=null){retired=connection.closeAsync();connection=null;if(!retired.isDone())throw new IllegalStateException("Connection closing");}
                    var connecting=client.connectAsync(StringCodec.UTF8,uri);attempts++;
                    try{connection=connecting.get(remaining(end),TimeUnit.NANOSECONDS);}
                    catch(Exception error){
                        // Retain ownership of a late connect until its socket has actually closed. Do not cancel then create another.
                        retired=connecting.toCompletableFuture().handle((c,e)->c).thenCompose(c->c==null?CompletableFuture.completedFuture(null):c.closeAsync());throw error;
                    }
                }
                commands.set(1);peakCommands=Math.max(peakCommands,1);sent=true;
                var future=connection.async().<String>eval(script,ScriptOutputType.VALUE,new String[]{key,key+":guard"},args);
                String reply=future.get(remaining(end),TimeUnit.NANOSECONDS);commands.set(0);return reply;
            } catch(Exception error){
                if(connection!=null){retired=connection.closeAsync();connection=null;retired.whenComplete((v,e)->commands.set(0));}
                else if(!sent)commands.set(0);
                throw new RouteProblem(503,write&&sent?"ROUTE_WRITE_UNCONFIRMED":"ROUTE_REDIS_UNAVAILABLE",write?(sent?"unknown":"not-written"):"not-applicable",
                    write&&sent?"发布可能已执行，但确认未到达。不要自动重发；读取当前状态只能用于重新核对，不能证明原提交结果。":"路由 Redis 连接或读取不可用；保留最后有效路由");
            }
        }
        private long remaining(long end)throws TimeoutException{long n=end-System.nanoTime();if(n<=0)throw new TimeoutException("Route command deadline");return n;}
        Map<String,Object> status(){var current=connection;return Map.of("commandsInFlight",commands.get(),"peakCommandsInFlight",peakCommands,"connectionAttempts",attempts,"connectionOpen",current!=null&&current.isOpen(),"retiring",!retired.isDone(),"closed",closed);}
        synchronized void close(){if(closed)return;closed=true;if(connection!=null){retired=connection.closeAsync();connection=null;}
            try{retired.get(2,TimeUnit.SECONDS);}catch(Exception ignored){}client.shutdown(Duration.ZERO,Duration.ofSeconds(1));commands.set(0);}
    }
}
