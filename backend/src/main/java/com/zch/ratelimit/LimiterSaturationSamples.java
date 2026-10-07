package com.zch.ratelimit;

import java.util.*;
import java.util.concurrent.atomic.*;
import java.util.function.*;

/** Optional bounded event evidence. No I/O, stack walking, timers, or executor is added. */
final class LimiterSaturationSamples {
    static final int CAPACITY=128;
    static final long INTERVAL_NANOS=100_000_000L;
    private final boolean enabled;
    private final LongSupplier nanoTime,wallTime;
    private final AtomicLong nextSample=new AtomicLong(Long.MIN_VALUE),sequence=new AtomicLong();
    private final LongAdder offered=new LongAdder(),suppressed=new LongAdder(),errors=new LongAdder();
    private final AtomicReferenceArray<Sample> ring=new AtomicReferenceArray<>(CAPACITY);
    record Sample(long sequence,long epochMillis,long monotonicNanos,String reason,Map<String,Object> state) {}
    LimiterSaturationSamples(boolean enabled){this(enabled,System::nanoTime,System::currentTimeMillis);}
    LimiterSaturationSamples(boolean enabled,LongSupplier nanoTime,LongSupplier wallTime){this.enabled=enabled;this.nanoTime=nanoTime;this.wallTime=wallTime;}
    boolean enabled(){return enabled;}
    void capture(String reason,Supplier<Map<String,Object>> state){
        if(!enabled)return;
        offered.increment();long now=nanoTime.getAsLong(),next=nextSample.get();
        if((next!=Long.MIN_VALUE&&now-next<0)||!nextSample.compareAndSet(next,now+INTERVAL_NANOS)){suppressed.increment();return;}
        long id=sequence.incrementAndGet();
        try{
            Sample value=new Sample(id,wallTime.getAsLong(),now,reason,Collections.unmodifiableMap(new LinkedHashMap<>(state.get())));
            int slot=(int)((id-1)%CAPACITY);
            // A paused older collector must never overwrite a newer sample in the same ring slot.
            Sample old;
            do{old=ring.get(slot);if(old!=null&&old.sequence()>=id)return;}while(!ring.compareAndSet(slot,old,value));
        }catch(RuntimeException error){errors.increment();} // Diagnostics must not change a quota decision.
    }
    Map<String,Object> status(){return since(0);}
    Map<String,Object> since(long after){
        var samples=new ArrayList<Sample>();for(int i=0;i<CAPACITY;i++){var s=ring.get(i);if(s!=null)samples.add(s);}
        samples.sort(Comparator.comparingLong(Sample::sequence));
        var result=summary();result.put("retainedCount",samples.size());
        result.put("oldestRetainedSequence",samples.isEmpty()?null:samples.getFirst().sequence());
        result.put("cursorTooOld",after>0&&!samples.isEmpty()&&samples.getFirst().sequence()>after+1);
        result.put("samples",samples.stream().filter(s->s.sequence()>after).toList());return result;
    }
    Map<String,Object> summary(){
        var result=new LinkedHashMap<String,Object>();
        result.put("enabled",enabled);result.put("capacity",CAPACITY);result.put("minimumIntervalMs",INTERVAL_NANOS/1_000_000);
        result.put("offered",offered.sum());result.put("suppressed",suppressed.sum());result.put("captureErrors",errors.sum());
        result.put("lastSequence",sequence.get());
        result.put("note","Rejection-triggered, rate-limited, non-atomic local observations. At most 256 retained tasks inspected and 8 oldest detailed. No IP or request ID. Thread state and GC counters do not prove scheduler causality.");
        return result;
    }
}
