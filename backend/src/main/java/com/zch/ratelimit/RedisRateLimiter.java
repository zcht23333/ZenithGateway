package com.zch.ratelimit;

import com.zch.config.RuntimeConfigSnapshot;
import com.zch.config.RuntimeConfigSyncProperties;
import io.lettuce.core.ClientOptions;
import io.lettuce.core.RedisClient;
import io.lettuce.core.RedisFuture;
import io.lettuce.core.RedisURI;
import io.lettuce.core.ScriptOutputType;
import io.lettuce.core.SocketOptions;
import io.lettuce.core.api.StatefulRedisConnection;
import io.lettuce.core.codec.StringCodec;
import io.lettuce.core.resource.DefaultClientResources;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import org.springframework.beans.factory.DisposableBean;
import com.zch.monitor.RequestObservation;
import org.springframework.boot.data.redis.autoconfigure.DataRedisProperties;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Mono;
import reactor.core.publisher.MonoSink;
import tools.jackson.databind.json.JsonMapper;

/** Bounded physical I/O ownership, not just bounded Reactor subscriptions. */
@Service("versionedIpRateLimiter")
public final class RedisRateLimiter implements RateLimitDecider,DisposableBean {
    private static final org.slf4j.Logger log=org.slf4j.LoggerFactory.getLogger(RedisRateLimiter.class);
    private final com.zch.monitor.GatewayMetrics metrics;
    private final LimiterProperties policy;
    private final String instanceId;
    private final JsonMapper mapper;
    private final String script;
    private final RedisURI uri;
    private final DefaultClientResources resources;
    private final RedisClient client;
    private final ThreadPoolExecutor workers,deliveries;
    private final LimiterTelemetry telemetry=new LimiterTelemetry();
    private final LimiterSaturationSamples saturation;
    private final java.util.List<java.lang.management.GarbageCollectorMXBean> gcBeans=java.lang.management.ManagementFactory.getGarbageCollectorMXBeans();
    private final AtomicInteger activeDeliveries=new AtomicInteger(),activeInlineDeliveries=new AtomicInteger(),peakDeliveries=new AtomicInteger();
    private final Semaphore admission;
    private final ScheduledThreadPoolExecutor clock;
    private final Set<Slot> slots=ConcurrentHashMap.newKeySet();
    private final ThreadLocal<Slot> local=ThreadLocal.withInitial(()->{var s=new Slot();slots.add(s);return s;});
    private final Set<Task> tasks=ConcurrentHashMap.newKeySet();
    private final AtomicInteger inFlight=new AtomicInteger(),peakInFlight=new AtomicInteger(),peakQueue=new AtomicInteger();
    private final AtomicBoolean degraded=new AtomicBoolean(),probing=new AtomicBoolean(),closed=new AtomicBoolean();
    private final AtomicLong failureGeneration=new AtomicLong(),started=new AtomicLong(),completed=new AtomicLong(),recoveries=new AtomicLong(),probes=new AtomicLong();
    private final Map<String,AtomicLong> counts=new LinkedHashMap<>();
    private volatile String lastFailureReason;
    private volatile Instant lastFailureAt,lastRecoveryAt,lastConfirmedAt;
    private volatile LimitDecision lastDecision;

    public RedisRateLimiter(DataRedisProperties redis,LimiterProperties policy,RuntimeConfigSyncProperties sync,JsonMapper mapper) throws Exception {
        this(redis,policy,sync,mapper,null);
    }
    @org.springframework.beans.factory.annotation.Autowired
    public RedisRateLimiter(DataRedisProperties redis,LimiterProperties policy,RuntimeConfigSyncProperties sync,JsonMapper mapper,com.zch.monitor.GatewayMetrics metrics) throws Exception {
        this.metrics=metrics;policy.validate();this.policy=policy;this.mapper=mapper;instanceId=sync.getInstanceId();
        saturation=new LimiterSaturationSamples(policy.isSaturationSamplingEnabled());
        script=new ClassPathResource("rate-limit.lua").getContentAsString(StandardCharsets.UTF_8);
        if(redis.getSentinel()!=null||redis.getCluster()!=null||redis.getMasterreplica()!=null)
            throw new IllegalArgumentException("Distributed rate limiting currently requires standalone Redis");
        uri=redis.getUrl()==null?RedisURI.create(redis.getHost(),redis.getPort()):RedisURI.create(redis.getUrl());
        if(redis.getUrl()==null){
            uri.setDatabase(redis.getDatabase());uri.setSsl(redis.getSsl().isEnabled());
            String password=redis.getPassword();
            if(redis.getUsername()!=null)uri.setAuthentication(redis.getUsername(),password==null?"":password);
            else if(password!=null&&!password.isEmpty())uri.setAuthentication(password.toCharArray());
        }
        uri.setClientName("zenith-rate-limit:"+instanceId);uri.setTimeout(Duration.ofMillis(policy.getDecisionTimeoutMs()));
        resources=DefaultClientResources.builder().ioThreadPoolSize(2).computationThreadPoolSize(2).build();
        client=RedisClient.create(resources,uri);
        client.setOptions(ClientOptions.builder().autoReconnect(false)
                .disconnectedBehavior(ClientOptions.DisconnectedBehavior.REJECT_COMMANDS).requestQueueSize(8)
                .socketOptions(SocketOptions.builder().connectTimeout(Duration.ofMillis(policy.getDecisionTimeoutMs())).build()).build());
        admission=new Semaphore(policy.getWorkers()+policy.getQueueCapacity());
        AtomicInteger ids=new AtomicInteger();
        workers=new ThreadPoolExecutor(policy.getWorkers(),policy.getWorkers(),0,TimeUnit.MILLISECONDS,
                policy.getQueueCapacity()==0?new SynchronousQueue<>():new ArrayBlockingQueue<>(policy.getQueueCapacity()),
                job->{Thread t=new Thread(job,"rate-limit-io-"+ids.incrementAndGet());t.setDaemon(true);return t;},new ThreadPoolExecutor.AbortPolicy());
        AtomicInteger deliveryIds=new AtomicInteger();
        deliveries=policy.isResultHandoffEnabled()?new ThreadPoolExecutor(policy.getResultWorkers(),policy.getResultWorkers(),0,TimeUnit.MILLISECONDS,
                new ArrayBlockingQueue<>(policy.getWorkers()+policy.getQueueCapacity()),
                job->{Thread t=new Thread(job,"rate-limit-result-"+deliveryIds.incrementAndGet());t.setDaemon(true);return t;},new ThreadPoolExecutor.AbortPolicy()):null;
        clock=new ScheduledThreadPoolExecutor(1,job->{Thread t=new Thread(job,"rate-limit-deadlines");t.setDaemon(true);return t;});
        clock.setRemoveOnCancelPolicy(true);
        for(String name:new String[]{"disabled","allowed","limited","unfulfillable","redis_fail_open","local_fail_open","redis_rejected","local_rejected","cancelled"})counts.put(name,new AtomicLong());
        clock.scheduleWithFixedDelay(this::scheduleProbe,policy.getProbeIntervalMs(),policy.getProbeIntervalMs(),TimeUnit.MILLISECONDS);
    }

    @Override public Mono<LimitDecision> decide(RuntimeConfigSnapshot snapshot,String ip){
        return Mono.deferContextual(context -> Mono.create(sink->{
            RequestObservation observation=context.getOrDefault(RequestObservation.CONTEXT_KEY,null);
            started.incrementAndGet();
            Task task=new Task(snapshot,ip,sink,observation);
            task.future=new WorkerJob(task);
            sink.onCancel(()->task.terminate("cancelled","client_cancelled",true));
            synchronized(task){
            if(task.done.get())return;
            // Even immediate decisions share the terminal gate: cancellation can precede Mono.create's callback.
            if(!snapshot.rateLimit().enabled()){task.deliver(LimitDecision.local("disabled","disabled","not_sent"));return;}
            if(closed.get()){task.deliver(LimitDecision.local("local_fail_open","stopped","not_sent"));return;}
            if(snapshot.version()==null){task.deliver(LimitDecision.local("redis_fail_open","version_missing","not_sent"));return;}
            if(degraded.get()){task.deliver(LimitDecision.local("redis_fail_open","recovery_wait","not_sent"));return;}
            if(!admission.tryAcquire()){captureSaturation("admission_full");telemetry.rejection("admission_full");task.deliver(LimitDecision.local("local_fail_open","queue_full","not_sent","admission_full"));return;}
            task.admitted=true;task.physicalDone=false;tasks.add(task);
            try{
                task.timer=clock.schedule(()->task.terminate("redis_fail_open","decision_timeout",false),policy.getDecisionTimeoutMs(),TimeUnit.MILLISECONDS);
                workers.execute(task.future);peakQueue.accumulateAndGet(workers.getQueue().size(),Math::max);
                if(task.done.get())task.cancelWork();
            }catch(RejectedExecutionException error){
                task.workFinished();
                if(closed.get())task.deliver(LimitDecision.local("local_fail_open","stopped","not_sent"));
                else{captureSaturation("executor_rejected");telemetry.rejection("executor_rejected");task.deliver(LimitDecision.local("local_fail_open","queue_full","not_sent","executor_rejected"));}
            }
            }
        }));
    }
    private void record(LimitDecision decision,RequestObservation observation){
        // Publish the chosen terminal fact even if cancellation wins before MonoSink delivers it.
        if(observation!=null)observation.limiter(decision);
        if(metrics!=null)metrics.limiterDecision(decision);
        telemetry.decision(decision);telemetry.reason(decision.reason());counts.get(decision.outcome()).incrementAndGet();completed.incrementAndGet();lastDecision=decision;
        if("confirmed".equals(decision.execution()))lastConfirmedAt=Instant.now();
    }
    private final class Task {
        final RuntimeConfigSnapshot snapshot;final String ip;final MonoSink<LimitDecision> sink;final RequestObservation observation;
        final long submitted=System.nanoTime(),deadline=submitted+TimeUnit.MILLISECONDS.toNanos(policy.getDecisionTimeoutMs());
        final AtomicBoolean done=new AtomicBoolean(),cancelled=new AtomicBoolean();
        volatile String ioPhase="queued",resultPhase="none";
        volatile long ioChangedAt=submitted,resultChangedAt=submitted,replyObservedAt;
        volatile Thread ioThread,resultThread;
        void markIo(String phase){if(saturation.enabled()){ioChangedAt=System.nanoTime();ioPhase=phase;ioThread=Thread.currentThread();}}
        void markResult(String phase){if(saturation.enabled()){resultChangedAt=System.nanoTime();resultPhase=phase;resultThread=Thread.currentThread();}}
        Map<String,Object> sample(long now){
            var value=new LinkedHashMap<String,Object>();
            value.put("ageMs",Math.max(0,now-submitted)/1_000_000.0);value.put("ioPhase",ioPhase);value.put("resultPhase",resultPhase);
            value.put("ioPhaseAgeMs",Math.max(0,now-ioChangedAt)/1_000_000.0);value.put("resultPhaseAgeMs",Math.max(0,now-resultChangedAt)/1_000_000.0);
            value.put("replyObservedAgeMs",replyObservedAt==0?null:Math.max(0,now-replyObservedAt)/1_000_000.0);
            value.put("decisionChosen",done.get());
            if(ioThread!=null){value.put("ioThreadId",ioThread.threadId());value.put("ioThreadName",ioThread.getName());value.put("ioThreadState",ioThread.getState().name());}
            if(resultThread!=null){value.put("resultThreadId",resultThread.threadId());value.put("resultThreadName",resultThread.getName());value.put("resultThreadState",resultThread.getState().name());}
            return value;
        }
        volatile boolean dispatched,workStarted;boolean admitted,physicalDone=true,resultDone;
        volatile WorkerJob future;volatile ScheduledFuture<?> timer;volatile Delivery delivery;
        Task(RuntimeConfigSnapshot s,String ip,MonoSink<LimitDecision> sink,RequestObservation observation){snapshot=s;this.ip=ip;this.sink=sink;this.observation=observation;}
        synchronized boolean choose(LimitDecision decision){
            if(!done.compareAndSet(false,true))return false;
            if(timer!=null)timer.cancel(false);
            record(decision,observation);telemetry.duration("decision",System.nanoTime()-submitted);
            releaseIfReady();return true;
        }
        void terminate(String outcome,String reason,boolean cancel){
            LimitDecision decision;
            synchronized(this){
                if(cancel&&cancelled.compareAndSet(false,true)&&done.get())telemetry.postDecisionCancellations.increment();
                if(done.get()){if(cancel)cancelDelivery();return;}
                if(!cancel&&reason.equals("decision_timeout")&&!workStarted){outcome="local_fail_open";reason="queue_timeout";}
                decision=LimitDecision.local(outcome,reason,dispatched?"unknown":"not_sent").withPolicy(policy);
                if(!choose(decision))return;
            }
            // Interrupt/remove I/O before emitting, so a downstream consumer cannot delay cancellation.
            cancelWork();
            if(cancel){deliveryFinished();return;}
            if(workStarted&&!reason.equals("stopped"))trip(reason);
            dispatch(decision);
        }
        void cancelWork(){
            WorkerJob job=future;if(job!=null){boolean removed=workers.remove(job);job.cancel(true);if(removed)workFinished();}
        }
        void cancelDelivery(){
            Delivery job=delivery;
            if(job!=null&&deliveries!=null&&deliveries.remove(job))deliveryFinished();
        }
        void deliver(LimitDecision raw){var decision=raw.withPolicy(policy);if(choose(decision))dispatch(decision);}
        void dispatch(LimitDecision decision){
            if(deliveries==null||!admitted){emit(decision,false);return;}
            markResult("queued");Delivery job=new Delivery(this,decision);delivery=job;
            try{deliveries.execute(job);peakDeliveries.accumulateAndGet(deliveries.getQueue().size(),Math::max);}
            catch(RejectedExecutionException error){
                // Admission reserves enough delivery capacity. Only shutdown should reject here.
                telemetry.rejection("delivery_rejected");
                try{sink.error(new CancellationException("Rate limiter stopped before result delivery"));}
                finally{deliveryFinished();}
            }
        }
        void emit(LimitDecision decision,boolean handedOff){
            var busy=handedOff?activeDeliveries:activeInlineDeliveries;
            markResult(handedOff?"delivery":"inline_delivery");long start=System.nanoTime();busy.incrementAndGet();
            try{if(!cancelled.get())sink.success(decision);}
            finally{telemetry.duration("delivery",System.nanoTime()-start);busy.decrementAndGet();deliveryFinished();}
        }
        synchronized void workFinished(){markIo("complete");physicalDone=true;releaseIfReady();}
        synchronized void deliveryFinished(){markResult("complete");resultDone=true;releaseIfReady();}
        private void releaseIfReady(){
            // One reservation spans both the physical I/O job and synchronous result-consumer invocation.
            // The inline baseline keeps its original early-release behavior for controlled comparisons.
            if(admitted&&done.get()&&(!policy.isResultHandoffEnabled()||physicalDone&&resultDone)){
                admitted=false;tasks.remove(this);admission.release();
            }
        }
    }
    private final class WorkerJob extends FutureTask<Void> {
        final Task task;
        WorkerJob(Task task){super(()->{execute(task);return null;});this.task=task;}
        @Override public void run(){try{super.run();}finally{task.workFinished();}}
    }
    private final class Delivery implements Runnable {
        final Task task;final LimitDecision decision;final long submitted=System.nanoTime();
        Delivery(Task task,LimitDecision decision){this.task=task;this.decision=decision;}
        @Override public void run(){telemetry.duration("handoff_queue",System.nanoTime()-submitted);task.emit(decision,true);}
    }
    private final class Command {
        final AtomicBoolean waiting=new AtomicBoolean(true);final long sent=System.nanoTime();
        final Task task;
        Command(){this(null);}
        Command(Task task){this.task=task;peakInFlight.accumulateAndGet(inFlight.incrementAndGet(),Math::max);}
        <T> RedisFuture<T> observe(RedisFuture<T> future){
            future.whenComplete((v,error)->observed());return future;
        }
        private synchronized boolean retire(){
            // The losing observer must not return to its worker before the decrement.
            // Only this command contends here: no diagnostics, callbacks or I/O under the lock.
            if(!waiting.get())return false;
            inFlight.decrementAndGet();waiting.set(false);return true;
        }
        void observed(){
            if(retire()){if(task!=null&&saturation.enabled())task.replyObservedAt=System.nanoTime();telemetry.commandResultsObserved.increment();telemetry.duration("command_observation",System.nanoTime()-sent);}
        }
        void closed(){
            if(retire())telemetry.commandsAbandonedAfterClose.increment();
        }
    }
    private static final class Slot {
        volatile Task owner;
        volatile StatefulRedisConnection<String,String> connection;
        volatile CompletableFuture<StatefulRedisConnection<String,String>> connecting;
        volatile boolean closing,quarantined;
    }
    private StatefulRedisConnection<String,String> connection(Slot slot,long deadline) throws Exception {
        if(slot.quarantined)throw new IllegalStateException("Physical connection slot is quarantined");
        if(slot.connection!=null&&slot.connection.isOpen())return slot.connection;
        discard(slot);
        // Never cancel away ownership of an in-progress connect: await its terminal close before reusing this slot.
        slot.connecting=client.connectAsync(StringCodec.UTF8,uri).toCompletableFuture();
        slot.connection=slot.connecting.get(remaining(deadline),TimeUnit.NANOSECONDS);slot.connecting=null;
        return slot.connection;
    }
    private void execute(Task task){
        if(task.done.get())return;
        if(degraded.get()){task.deliver(LimitDecision.local("redis_fail_open","recovery_wait","not_sent"));return;}
        task.workStarted=true;Slot slot=local.get();slot.owner=task;Command command=null;boolean discard=false;
        long startedAt=System.nanoTime();telemetry.duration("queue",startedAt-task.submitted);
        try{
            task.markIo("connection");long phase=System.nanoTime();var connection=connection(slot,task.deadline);telemetry.duration("connection",System.nanoTime()-phase);
            RedisFuture<String> pending;
            synchronized(task){
                if(task.done.get()){discard=true;return;}
                var rate=task.snapshot.rateLimit();task.dispatched=true;task.markIo("redis_wait");command=new Command(task);
                pending=command.observe(connection.async().eval(script,ScriptOutputType.VALUE,
                        new String[]{policy.getNamespace()+":policy",policy.getNamespace()+":bucket:"+task.ip},
                        task.snapshot.version(),""+rate.burstCapacity(),""+rate.replenishRate(),""+rate.requestedTokens()));
            }
            phase=System.nanoTime();String reply;
            try{reply=pending.get(remaining(task.deadline),TimeUnit.NANOSECONDS);command.observed();}
            finally{telemetry.duration("redis_wait_and_resume",System.nanoTime()-phase);}
            task.markIo("decode");phase=System.nanoTime();
            var decision=mapper.readValue(reply,LimitDecision.class);
            if(!Set.of("allowed","limited","unfulfillable","redis_fail_open").contains(decision.outcome()))throw new IllegalStateException("Invalid limiter reply");
            if(!("redis_fail_open".equals(decision.outcome())?"not_written":"confirmed").equals(decision.execution()))
                throw new IllegalStateException("Invalid limiter execution fact");
            telemetry.duration("decode",System.nanoTime()-phase);
            task.markIo("result_dispatch");task.deliver(decision);
            discard=Thread.currentThread().isInterrupted();
        }catch(Exception error){
            discard=true;
            if(!task.done.get()){
                String reason=error instanceof TimeoutException?"decision_timeout":"redis_error";trip(reason);
                task.deliver(LimitDecision.local("redis_fail_open",reason,task.dispatched?"unknown":"not_sent"));
            }
        }finally{
            task.markIo("cleanup");long cleanup=System.nanoTime();
            // A cancelled Future does not retract a command. Retain ownership through physical close.
            if(discard)discard(slot);
            if(command!=null&&discard&&!slot.quarantined)command.closed();
            telemetry.duration("cleanup",System.nanoTime()-cleanup);
            telemetry.duration("worker_total",System.nanoTime()-startedAt);slot.owner=null;Thread.interrupted();
        }
    }
    private void discard(Slot slot){
        slot.closing=true;
        try{
            if(slot.connecting!=null){
                slot.connecting.handle((c,e)->c==null?CompletableFuture.<Void>completedFuture(null):c.closeAsync()).thenCompose(x->x).join();
                slot.connecting=null;
            }
            if(slot.connection!=null){slot.connection.closeAsync().join();slot.connection=null;}
        }catch(Exception error){slot.quarantined=true;log.warn("Rate-limit connection slot quarantined until shutdown");}
        finally{slot.closing=false;}
    }
    private synchronized void trip(String reason){
        failureGeneration.incrementAndGet();lastFailureReason=reason;lastFailureAt=Instant.now();
        if(degraded.compareAndSet(false,true))log.warn("Rate-limit Redis degraded: {}; policy={} until a bounded probe succeeds; execution may be unknown",reason,policy.getRedisFailurePolicy());
    }
    private void scheduleProbe(){
        if(closed.get()||!degraded.get()||!probing.compareAndSet(false,true))return;
        try{workers.execute(()->{
            long generation=failureGeneration.get();Slot slot=local.get();Command command=null;
            try{
                probes.incrementAndGet();long deadline=System.nanoTime()+TimeUnit.MILLISECONDS.toNanos(policy.getDecisionTimeoutMs());
                var c=connection(slot,deadline);command=new Command();
                // Exercise the EVAL command path (including CLIENT PAUSE WRITE), without touching a bucket.
                String pong=command.observe(c.async().<String>eval("return 'PONG'",ScriptOutputType.VALUE,new String[0])).get(remaining(deadline),TimeUnit.NANOSECONDS);command.observed();
                if("PONG".equals(pong))recover(generation);
            }catch(Exception error){discard(slot);if(command!=null&&!slot.quarantined)command.closed();lastFailureAt=Instant.now();}
            finally{probing.set(false);Thread.interrupted();}
        });}catch(RejectedExecutionException error){probing.set(false);}
    }
    private synchronized void recover(long generation){
        if(failureGeneration.get()==generation&&!closed.get()){
            degraded.set(false);recoveries.incrementAndGet();lastRecoveryAt=Instant.now();log.info("Rate-limit Redis transport recovered; next request must obtain its own quota decision");
        }
    }
    private static long remaining(long deadline) throws TimeoutException {
        long n=deadline-System.nanoTime();if(n<=0)throw new TimeoutException("Rate-limit decision deadline exhausted");return n;
    }
    private void captureSaturation(String reason){saturation.capture(reason,this::saturationState);}
    private Map<String,Object> saturationState(){
        long now=System.nanoTime();var value=new LinkedHashMap<String,Object>();
        value.put("availablePermits",admission.availablePermits());value.put("admissionCapacity",policy.getWorkers()+policy.getQueueCapacity());
        value.put("retainedTasks",tasks.size());value.put("ioQueued",workers.getQueue().size());value.put("activeWorkers",workers.getActiveCount());
        value.put("commandsInFlight",inFlight.get());value.put("resultQueued",deliveries==null?0:deliveries.getQueue().size());
        value.put("activeDeliveries",activeDeliveries.get());value.put("activeInlineDeliveries",activeInlineDeliveries.get());
        var ioCounts=new LinkedHashMap<String,Integer>();var resultCounts=new LinkedHashMap<String,Integer>();
        var oldest=new java.util.ArrayList<Task>(8);int inspected=0;
        for(Task task:tasks){
            if(inspected>=256)break;inspected++;ioCounts.merge(task.ioPhase,1,Integer::sum);resultCounts.merge(task.resultPhase,1,Integer::sum);
            if(oldest.size()<8||task.submitted<oldest.getLast().submitted){oldest.add(task);oldest.sort(java.util.Comparator.comparingLong(x->x.submitted));if(oldest.size()>8)oldest.removeLast();}
        }
        value.put("tasksInspected",inspected);value.put("taskScanMayBeTruncated",tasks.size()>inspected);
        value.put("ioPhases",ioCounts);value.put("resultPhases",resultCounts);value.put("oldestTasks",oldest.stream().map(t->t.sample(now)).toList());
        var owners=new java.util.ArrayList<Map<String,Object>>();for(Slot slot:slots){Task task=slot.owner;if(task!=null&&owners.size()<64)owners.add(task.sample(now));}
        value.put("workerOwners",owners);value.put("gcCollections",gcBeans.stream().mapToLong(b->Math.max(0,b.getCollectionCount())).sum());
        value.put("gcCollectionMillis",gcBeans.stream().mapToLong(b->Math.max(0,b.getCollectionTime())).sum());
        return value;
    }
    public Map<String,Object> saturationStatus(long after){var value=saturation.since(after);value.put("instanceId",instanceId);return value;}
    public Map<String,Object> status(){
        var result=new LinkedHashMap<String,Object>();result.put("diagnosticSchemaVersion",3);result.put("source","local");result.put("instanceId",instanceId);
        result.put("localFailurePolicy",policy.getLocalFailurePolicy().name().toLowerCase(java.util.Locale.ROOT));result.put("redisFailurePolicy",policy.getRedisFailurePolicy().name().toLowerCase(java.util.Locale.ROOT));
        result.put("namespace",policy.getNamespace());result.put("transportState",closed.get()?"stopped":degraded.get()?(probing.get()?"probing":"degraded"):lastConfirmedAt==null&&lastRecoveryAt==null?"unchecked":"healthy");
        result.put("workers",policy.getWorkers());result.put("queueCapacity",policy.getQueueCapacity());result.put("decisionTimeoutMs",policy.getDecisionTimeoutMs());result.put("probeIntervalMs",policy.getProbeIntervalMs());
        result.put("admissionCapacity",policy.getWorkers()+policy.getQueueCapacity());result.put("availableDecisionPermits",admission.availablePermits());result.put("scheduledTasks",clock.getQueue().size());
        result.put("queued",workers.getQueue().size());result.put("peakQueued",peakQueue.get());result.put("activeWorkers",workers.getActiveCount());
        result.put("commandsInFlight",inFlight.get());result.put("peakCommandsInFlight",peakInFlight.get());
        result.put("commandCountMeaning","Client dispatches without an observed result or a confirmed physical close, including probes; excludes decoding and downstream work. Not a Redis-server running-command count.");
        result.put("resultHandoffEnabled",policy.isResultHandoffEnabled());result.put("resultWorkers",deliveries==null?0:policy.getResultWorkers());
        result.put("deliveryQueueCapacity",deliveries==null?0:policy.getWorkers()+policy.getQueueCapacity());
        result.put("queuedDeliveries",deliveries==null?0:deliveries.getQueue().size());result.put("activeDeliveries",activeDeliveries.get());result.put("peakQueuedDeliveries",peakDeliveries.get());
        result.put("activeInlineDeliveries",activeInlineDeliveries.get());result.put("retainedTasks",tasks.size());result.put("observations",telemetry.status());result.put("saturationEvents",saturation.summary());
        result.put("connectionSlots",slots.size());result.put("connecting",slots.stream().filter(s->s.connecting!=null).count());result.put("openConnections",slots.stream().filter(s->s.connection!=null&&s.connection.isOpen()).count());
        result.put("closing",slots.stream().filter(s->s.closing).count());result.put("quarantined",slots.stream().filter(s->s.quarantined).count());
        result.put("lettuceQueueCapacityPerConnection",8);result.put("autoReconnect",false);result.put("offlineBuffering",false);
        result.put("decisionsStarted",started.get());result.put("decisionsCompleted",completed.get());var counters=new LinkedHashMap<String,Long>();counts.forEach((k,v)->counters.put(k,v.get()));result.put("outcomes",counters);
        result.put("probes",probes.get());result.put("recoveries",recoveries.get());result.put("lastFailureReason",lastFailureReason);result.put("lastFailureAt",lastFailureAt);result.put("lastRecoveryAt",lastRecoveryAt);result.put("lastConfirmedAt",lastConfirmedAt);result.put("lastDecision",lastDecision);
        return result;
    }
    @Override public void destroy(){
        if(!closed.compareAndSet(false,true))return;
        tasks.forEach(t->t.terminate("local_fail_open","stopped",false));
        clock.shutdownNow();
        for(Runnable job:workers.shutdownNow())if(job instanceof WorkerJob w){w.cancel(true);w.task.workFinished();}
        if(deliveries!=null)deliveries.shutdown();
        for(Slot slot:slots){if(slot.connection!=null)slot.connection.closeAsync();}
        client.shutdown(Duration.ZERO,Duration.ofSeconds(2));resources.shutdown(0,2,TimeUnit.SECONDS).syncUninterruptibly();
        try{workers.awaitTermination(3,TimeUnit.SECONDS);}catch(InterruptedException error){Thread.currentThread().interrupt();}
        stopDeliveries();
        log.info("Rate-limit workers stopped; active={}, queued={}, commands={}",workers.getActiveCount(),workers.getQueue().size(),inFlight.get());
        log.info("Rate-limit result dispatch stopped; active={}, queued={}, retained={}",activeDeliveries.get(),deliveries==null?0:deliveries.getQueue().size(),tasks.size());
    }
    private void abortDeliveries(){
        for(Runnable job:deliveries.shutdownNow())if(job instanceof Delivery d){
            d.task.cancelled.set(true);
            try{d.task.sink.error(new CancellationException("Rate limiter stopped before delivery"));}
            finally{d.task.deliveryFinished();}
        }
    }
    private void stopDeliveries(){
        if(deliveries==null)return;
        boolean interrupted=false;
        try{if(!deliveries.awaitTermination(3,TimeUnit.SECONDS))abortDeliveries();}
        catch(InterruptedException error){interrupted=true;abortDeliveries();}
        try{deliveries.awaitTermination(1,TimeUnit.SECONDS);}
        catch(InterruptedException error){interrupted=true;abortDeliveries();}
        if(interrupted)Thread.currentThread().interrupt();
    }

}
