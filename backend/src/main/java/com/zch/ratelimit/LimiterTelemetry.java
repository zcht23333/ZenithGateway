package com.zch.ratelimit;

import java.util.*;
import java.util.concurrent.atomic.*;

/** Fixed-cardinality counters and fixed histogram storage; durations are wall time, not CPU time. */
final class LimiterTelemetry {
    private final Map<String,LongAdder> reasons=new LinkedHashMap<>(),rejections=new LinkedHashMap<>();
    private final Map<String,LongAdder> events=new LinkedHashMap<>(),actions=new LinkedHashMap<>(),executions=new LinkedHashMap<>();
    private final Map<String,Histogram> timings=new LinkedHashMap<>();
    final LongAdder postDecisionCancellations=new LongAdder(),commandResultsObserved=new LongAdder(),commandsAbandonedAfterClose=new LongAdder();
    LimiterTelemetry(){
        for(String key:List.of("disabled","allowed","limited","unfulfillable","local_unavailable","redis_unconfirmed","cancelled"))events.put(key,new LongAdder());
        for(String key:List.of("forward","reject","cancel"))actions.put(key,new LongAdder());
        for(String key:List.of("not_sent","not_written","confirmed","unknown"))executions.put(key,new LongAdder());
        for(String key:List.of("disabled","stopped","version_missing","recovery_wait","queue_full","queue_timeout",
                "client_cancelled","decision_timeout","redis_error","quota_available","quota_exhausted","cost_exceeds_capacity",
                "invalid_request","policy_invalid","bucket_invalid","policy_missing","epoch_mismatch","policy_conflict","policy_behind_bucket","other"))
            reasons.put(key,new LongAdder());
        for(String key:List.of("admission_full","executor_rejected","delivery_rejected"))rejections.put(key,new LongAdder());
        for(String key:List.of("queue","connection","redis_wait_and_resume","command_observation","decode","decision",
                "handoff_queue","delivery","cleanup","worker_total"))timings.put(key,new Histogram());
    }
    void decision(LimitDecision d){events.get(d.event()).increment();actions.get(d.action()).increment();executions.get(d.execution()).increment();}
    void reason(String reason){reasons.getOrDefault(reason,reasons.get("other")).increment();}
    void rejection(String source){rejections.get(source).increment();}
    void duration(String phase,long nanos){timings.get(phase).add(Math.max(0,nanos));}
    Map<String,Object> status(){
        var result=new LinkedHashMap<String,Object>();
        result.put("events",values(events));result.put("actions",values(actions));result.put("executions",values(executions));
        result.put("reasons",values(reasons));result.put("rejections",values(rejections));
        var times=new LinkedHashMap<String,Object>();timings.forEach((k,v)->times.put(k,v.view()));result.put("timings",times);
        result.put("postDecisionCancellations",postDecisionCancellations.sum());
        result.put("commandResultsObserved",commandResultsObserved.sum());
        result.put("commandsAbandonedAfterClose",commandsAbandonedAfterClose.sum());
        result.put("note","Cumulative, non-atomic local observations. Durations include scheduling and GC; command observation is not Redis server execution time. Post-decision cancellation does not undo the quota decision.");
        return result;
    }
    private static Map<String,Long> values(Map<String,LongAdder> input){var result=new LinkedHashMap<String,Long>();input.forEach((k,v)->result.put(k,v.sum()));return result;}
    private static final class Histogram {
        static final long[] BOUNDS={50_000,100_000,250_000,500_000,1_000_000,2_000_000,5_000_000,10_000_000,20_000_000,50_000_000,100_000_000,500_000_000,Long.MAX_VALUE};
        final LongAdder count=new LongAdder(),total=new LongAdder();
        final AtomicLong max=new AtomicLong();
        final LongAdder[] buckets=Arrays.stream(BOUNDS).mapToObj(x->new LongAdder()).toArray(LongAdder[]::new);
        void add(long nanos){count.increment();total.add(nanos);max.accumulateAndGet(nanos,Math::max);int i=0;while(nanos>BOUNDS[i])i++;buckets[i].increment();}
        Map<String,Object> view(){return Map.of("count",count.sum(),"totalNanos",total.sum(),"maxNanos",max.get(),
                "upperBoundsNanos",BOUNDS.clone(),"buckets",Arrays.stream(buckets).mapToLong(LongAdder::sum).toArray());}
    }
}
