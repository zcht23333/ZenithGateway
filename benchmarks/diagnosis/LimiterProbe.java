package com.zch.ratelimit;

import java.time.Instant;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.*;

/** Experiment-only, bounded observations; copied into an isolated build, never the application source. */
final class LimiterProbe {
    static final String CONNECT="connection", REDIS="redis_roundtrip_and_resume", DECODE="decode",
            DELIVER="delivery", CLEANUP="cleanup", IDLE="idle";
    private final boolean enabled=Boolean.parseBoolean(System.getProperty("zenith.limiter.probe.enabled","true"));
    private final Map<String,LongAdder> reasons=new LinkedHashMap<>();
    private final Map<String,LongAdder> rejections=new LinkedHashMap<>();
    private final Map<String,Histogram> timings=new LinkedHashMap<>();
    private final Set<Worker> workers=ConcurrentHashMap.newKeySet();
    private final AtomicLong sampleAfter=new AtomicLong(),slowAfter=new AtomicLong();
    private final Ring saturation=new Ring(128),slow=new Ring(128),roundtrips=new Ring(128);
    private final AtomicLong tripAfter=new AtomicLong();
    private final LongAdder callbackObserved=new LongAdder(),callbackMissing=new LongAdder();
    private final AtomicLong saturationSeen=new AtomicLong(),slowSeen=new AtomicLong();
    LimiterProbe(){
        for(String k:List.of("disabled","stopped","version_missing","recovery_wait","queue_full","queue_timeout",
                "client_cancelled","decision_timeout","redis_error","quota_available","quota_exhausted",
                "cost_exceeds_capacity","invalid_request","policy_invalid","bucket_invalid","policy_missing",
                "epoch_mismatch","policy_conflict","policy_behind_bucket","other"))reasons.put(k,new LongAdder());
        for(String k:List.of("admission_full","executor_rejected"))rejections.put(k,new LongAdder());
        for(String k:List.of("queue",CONNECT,REDIS,DECODE,DELIVER,CLEANUP,"worker_total","send_to_reply_callback","reply_callback_to_resume"))timings.put(k,new Histogram());
    }
    final class Worker {
        final Thread thread=Thread.currentThread();
        volatile String phase=IDLE; volatile long since,started;
        void begin(long submitted){
            if(!enabled)return;
            long n=System.nanoTime();timings.get("queue").add(Math.max(0,n-submitted));started=n;since=n;phase=CONNECT;
        }
        void mark(String next){
            if(!enabled)return;
            long n=System.nanoTime(),elapsed=n-since;String before=phase;
            if(!IDLE.equals(before))timings.get(before).add(elapsed);
            if(elapsed>=20_000_000L&&!IDLE.equals(before)){
                slowSeen.incrementAndGet();long after=slowAfter.get();
                if(n>=after&&slowAfter.compareAndSet(after,n+100_000_000L))
                    slow.add(Map.of("at",Instant.now().toString(),"thread",thread.getName(),"phase",before,"elapsedMs",elapsed/1_000_000d));
            }
            since=n;phase=next;
            if(IDLE.equals(next))timings.get("worker_total").add(n-started);
        }
        Map<String,Object> view(long now){
            String p=phase;long s=since;
            return Map.of("thread",thread.getName(),"phase",p,"ageMs",IDLE.equals(p)?0:Math.max(0,now-s)/1_000_000d,"state",thread.getState().name());
        }
    }
    Worker worker(){var w=new Worker();if(enabled)workers.add(w);return w;}
    void reason(String reason){if(enabled)reasons.getOrDefault(reason,reasons.get("other")).increment();}
    void reject(String source,int queued,int permits,int commands){
        if(!enabled)return;
        rejections.get(source).increment();saturationSeen.incrementAndGet();
        long n=System.nanoTime(),after=sampleAfter.get();
        if(n<after||!sampleAfter.compareAndSet(after,n+100_000_000L))return;
        saturation.add(Map.of("at",Instant.now().toString(),"source",source,"queued",queued,
            "availablePermits",permits,"commandsInFlight",commands,"workers",workers.stream().map(w->w.view(n)).toList()));
    }
    void roundtrip(long sentNanos,long sentWall,long resumedNanos,long resumedWall,Long serverWall,
            long callbackNanos,String callbackThread){
        if(!enabled)return;
        boolean observed=callbackNanos>=sentNanos&&callbackNanos<=resumedNanos;
        if(observed){
            callbackObserved.increment();timings.get("send_to_reply_callback").add(callbackNanos-sentNanos);
            timings.get("reply_callback_to_resume").add(resumedNanos-callbackNanos);
        }else callbackMissing.increment();
        long elapsed=resumedNanos-sentNanos,after=tripAfter.get();
        if(elapsed<10_000_000L||resumedNanos<after||!tripAfter.compareAndSet(after,resumedNanos+100_000_000L))return;
        var item=new LinkedHashMap<String,Object>();item.put("at",Instant.ofEpochMilli(resumedWall).toString());
        item.put("roundtripMs",elapsed/1_000_000d);item.put("sentWallMs",sentWall);item.put("serverWallMs",serverWall);
        item.put("resumedWallMs",resumedWall);item.put("sendToServerMs",serverWall==null?null:serverWall-sentWall);
        item.put("serverToResumeMs",serverWall==null?null:resumedWall-serverWall);
        item.put("callbackObservedBeforeResume",observed);item.put("callbackThread",callbackThread);
        item.put("sendToCallbackMs",observed?(callbackNanos-sentNanos)/1_000_000d:null);
        item.put("callbackToResumeMs",observed?(resumedNanos-callbackNanos)/1_000_000d:null);
        roundtrips.add(item);
    }
    Map<String,Object> status(){
        var result=new LinkedHashMap<String,Object>();result.put("enabled",enabled);
        result.put("reasons",values(reasons));result.put("rejections",values(rejections));
        var times=new LinkedHashMap<String,Object>();timings.forEach((k,v)->times.put(k,v.view()));result.put("timings",times);
        result.put("saturationSeen",saturationSeen.get());result.put("saturationSamples",saturation.view());
        result.put("roundtripSamples",roundtrips.view());result.put("callbacksObservedBeforeResume",callbackObserved.sum());result.put("callbacksNotObservedBeforeResume",callbackMissing.sum());
        result.put("slowSeen",slowSeen.get());result.put("slowSamples",slow.view());
        result.put("sampleLimit",128);result.put("minimumSampleIntervalMs",100);
        result.put("note","Cumulative, non-atomic observations. Wall durations include scheduling/GC. REDIS includes dispatch, transport, server execution, decode on Lettuce, and worker rescheduling. Not server CPU time.");
        return result;
    }
    private static Map<String,Long> values(Map<String,LongAdder> input){var r=new LinkedHashMap<String,Long>();input.forEach((k,v)->r.put(k,v.sum()));return r;}
    private static final class Histogram {
        final long[] bounds={50_000,100_000,250_000,500_000,1_000_000,2_000_000,5_000_000,10_000_000,20_000_000,50_000_000,100_000_000,500_000_000,Long.MAX_VALUE};
        final LongAdder count=new LongAdder(),nanos=new LongAdder(); final AtomicLong max=new AtomicLong();
        final LongAdder[] buckets=Arrays.stream(bounds).mapToObj(x->new LongAdder()).toArray(LongAdder[]::new);
        void add(long n){count.increment();nanos.add(n);max.accumulateAndGet(n,Math::max);int b=0;while(n>bounds[b])b++;buckets[b].increment();}
        Map<String,Object> view(){return Map.of("count",count.sum(),"totalNanos",nanos.sum(),"maxNanos",max.get(),
                "upperBoundsNanos",bounds,"buckets",Arrays.stream(buckets).mapToLong(LongAdder::sum).toArray());}
    }
    private static final class Ring {
        final Object[] items;long count;
        Ring(int size){items=new Object[size];}
        synchronized void add(Object value){items[(int)(count++%items.length)]=value;}
        synchronized List<Object> view(){var r=new ArrayList<>();for(long i=Math.max(0,count-items.length);i<count;i++)r.add(items[(int)(i%items.length)]);return r;}
    }
}
