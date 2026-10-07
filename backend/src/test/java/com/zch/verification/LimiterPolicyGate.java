package com.zch.verification;

import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.cloud.gateway.filter.*;
import org.springframework.core.Ordered;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.*;
import reactor.core.publisher.Mono;

/**
 * Test-only synchronous consumer gate. Packaged separately from the production jar.
 * Bounds: one gate, one latch, 5s maximum hold; releases on context shutdown.
 */
@RestController
@ConditionalOnProperty(name="zenith.verification.limiter-gate",havingValue="true")
public class LimiterPolicyGate implements GlobalFilter,Ordered,org.springframework.beans.factory.DisposableBean {
    private static final class Gate {final CountDownLatch release=new CountDownLatch(1);volatile boolean entered,timedOut;volatile String thread;}
    private final AtomicReference<Gate> gate=new AtomicReference<>();
    @Override public int getOrder(){return -199;}
    @Override public Mono<Void> filter(ServerWebExchange exchange,GatewayFilterChain chain){
        var g=gate.get();
        if(g!=null&&"hold".equals(exchange.getRequest().getHeaders().getFirst("X-Verification-Limiter-Gate"))){
            g.thread=Thread.currentThread().getName();g.entered=true;
            try{g.timedOut=!g.release.await(5,TimeUnit.SECONDS);}
            catch(InterruptedException e){Thread.currentThread().interrupt();}
        }
        return chain.filter(exchange);
    }
    @GetMapping("/settings/verification/limiter-gate")
    public ResponseEntity<Map<String,Object>> status(){
        var g=gate.get();return ResponseEntity.ok().header("Cache-Control","no-store").body(
            g==null?Map.of("armed",false):Map.of("armed",true,"entered",g.entered,"timedOut",g.timedOut,"thread",g.thread==null?"":g.thread));
    }
    @PostMapping("/settings/verification/limiter-gate")
    public ResponseEntity<Map<String,Object>> command(@RequestBody Map<String,String> command){
        if("arm".equals(command.get("action"))){
            if(!gate.compareAndSet(null,new Gate()))throw new ResponseStatusException(HttpStatus.CONFLICT,"Gate already armed");
        }else if("release".equals(command.get("action"))){destroy();}
        else throw new ResponseStatusException(HttpStatus.BAD_REQUEST,"Unknown gate action");
        return status();
    }
    @Override public void destroy(){var old=gate.getAndSet(null);if(old!=null)old.release.countDown();}
}
