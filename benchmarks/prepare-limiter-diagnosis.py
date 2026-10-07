"""Build input only: copy the backend and instrument the copy, preserving production sources."""
import argparse, hashlib, json, shutil
from pathlib import Path

parser=argparse.ArgumentParser()
parser.add_argument("output")
parser.add_argument("--source",help="Archived backend root (pom.xml and src) for reproducing the original diagnostic instrumentation.")
parser.add_argument("--production-fixture",action="store_true",help="Copy unchanged application code and the deterministic worker fixture only.")
args=parser.parse_args()
base=Path(__file__).resolve().parent.parent
out=Path(args.output).resolve()
assert out.is_relative_to(base/".dev"), "Diagnostic build must stay under this workspace's .dev"
assert not out.exists(), "Refuse to overwrite previous evidence/build"
backend=Path(args.source).resolve() if args.source else base/"backend"
if (backend/"src/main/java/com/zch/ratelimit/LimiterTelemetry.java").exists():
    raise SystemExit("Current backend already contains formal limiter diagnostics. Use benchmarks/limiter-handoff.mjs for current comparisons; use --source <archived backend root> to reproduce original instrumentation and WorkerOccupancyTest.")
out.mkdir()
shutil.copy2(backend/"pom.xml",out/"pom.xml")
shutil.copytree(backend/"src",out/"src")
if args.production_fixture:
    shutil.copy2(base/"benchmarks/diagnosis/WorkerOccupancyTest.java",out/"src/test/java/com/zch/ratelimit/WorkerOccupancyTest.java")
    print(out)
    raise SystemExit(0)
target=out/"src/main/java/com/zch/ratelimit/RedisRateLimiter.java"
source=target.read_text(encoding="utf-8-sig")
before=hashlib.sha256(target.read_bytes()).hexdigest()
def replace(old,new):
    global source
    assert source.count(old)==1, "Source changed; inspect instrumentation anchor: "+old
    source=source.replace(old,new)
replace("private volatile LimitDecision lastDecision;",
        "private volatile LimitDecision lastDecision;\n    private final LimiterProbe probe=new LimiterProbe();")
replace('if(!admission.tryAcquire()){task.deliver', 'if(!admission.tryAcquire()){probe.reject("admission_full",workers.getQueue().size(),admission.availablePermits(),inFlight.get());task.deliver')
replace('}catch(RejectedExecutionException error){task.deliver', '}catch(RejectedExecutionException error){probe.reject("executor_rejected",workers.getQueue().size(),admission.availablePermits(),inFlight.get());task.deliver')
replace('counts.get(decision.outcome()).incrementAndGet();', 'probe.reason(decision.reason());counts.get(decision.outcome()).incrementAndGet();')
replace('private static final class Slot {', 'private final class Slot {\n        final LimiterProbe.Worker measurement=probe.worker();')
replace('task.workStarted=true;Slot slot=local.get();boolean command=false,discard=false;',
        'task.workStarted=true;Slot slot=local.get();slot.measurement.begin(task.deadline-TimeUnit.MILLISECONDS.toNanos(policy.getDecisionTimeoutMs()));boolean command=false,discard=false;')
replace('var connection=connection(slot,task.deadline);RedisFuture<String> pending;',
        'var connection=connection(slot,task.deadline);slot.measurement.mark(LimiterProbe.REDIS);RedisFuture<String> pending;')
replace('var decision=mapper.readValue(reply,LimitDecision.class);',
        'slot.measurement.mark(LimiterProbe.DECODE);var decision=mapper.readValue(reply,LimitDecision.class);')
replace('task.deliver(decision);\n            discard=',
        'slot.measurement.mark(LimiterProbe.DELIVER);task.deliver(decision);slot.measurement.mark(LimiterProbe.CLEANUP);\n            discard=')
replace('if(command)inFlight.decrementAndGet();Thread.interrupted();',
        'if(command)inFlight.decrementAndGet();Thread.interrupted();slot.measurement.mark(LimiterProbe.IDLE);')
replace('return result;\n    }\n    @Override public void destroy()',
        'result.put("experimentProbe",probe.status());return result;\n    }\n    @Override public void destroy()')
replace('uri.setClientName("zenith-rate-limit:"+instanceId);',
        'if(System.getProperty("zenith.limiter.probe.redisHost")!=null)uri.setHost(System.getProperty("zenith.limiter.probe.redisHost"));uri.setClientName("zenith-rate-limit:"+instanceId);')
replace('volatile FutureTask<Void> future;volatile ScheduledFuture<?> timer;',
        'volatile FutureTask<Void> future;volatile ScheduledFuture<?> timer;volatile long replyCallbackNanos;volatile String replyCallbackThread;long sendNanos,sendWall;')
replace('pending=connection.async().eval(script,ScriptOutputType.VALUE,',
        'task.sendNanos=System.nanoTime();task.sendWall=System.currentTimeMillis();pending=connection.async().eval(script,ScriptOutputType.VALUE,')
replace('String reply=pending.get(remaining(task.deadline),TimeUnit.NANOSECONDS);',
        'pending.whenComplete((value,error)->{task.replyCallbackThread=Thread.currentThread().getName();task.replyCallbackNanos=System.nanoTime();});String reply=pending.get(remaining(task.deadline),TimeUnit.NANOSECONDS);long resumedNanos=System.nanoTime(),resumedWall=System.currentTimeMillis();')
replace('var decision=mapper.readValue(reply,LimitDecision.class);',
        'var decision=mapper.readValue(reply,LimitDecision.class);probe.roundtrip(task.sendNanos,task.sendWall,resumedNanos,resumedWall,decision.serverTimeMs(),task.replyCallbackNanos,task.replyCallbackThread);')
target.write_text(source,encoding="utf-8")
shutil.copy2(base/"benchmarks/diagnosis/LimiterProbe.java",target.with_name("LimiterProbe.java"))
(out/"instrumentation.json").write_text(json.dumps({"originalRedisRateLimiterSha256":before,
    "instrumentedSha256":hashlib.sha256(target.read_bytes()).hexdigest(),
    "behavior":"Bounded observations; optional experiment-only Redis hostname override. Unchanged limits, command scheduling, outcome selection and Lua.",
    "productionSource":str(backend/"src/main/java/com/zch/ratelimit/RedisRateLimiter.java")},indent=2),encoding="utf-8")
shutil.copy2(base/"benchmarks/diagnosis/WorkerOccupancyTest.java",out/"src/test/java/com/zch/ratelimit/WorkerOccupancyTest.java")
print(out)
