"""Summarize isolated limiter runs without interpreting HTTP 200 as a quota check."""
import argparse,collections,datetime,hashlib,json,re
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument("root");p.add_argument("--output");a=p.parse_args()
root=Path(a.root);runs=[]
def percentile_bound(h,numerator):
    total=h["count"]
    if not total:return None
    target=total*numerator/100;seen=0
    for bound,count in zip(h["upperBoundsNanos"],h["buckets"]):
        seen+=count
        if seen>=target:return bound/1e6
def instant(s):return datetime.datetime.fromisoformat(s.replace("Z","+00:00"))
for path in sorted(root.glob("*/summary.json")):
    d=json.loads(path.read_text(encoding="utf-8-sig"))
    if d.get("phase")!="diagnosis":continue
    row={"source":str(path.resolve()),"jar":d["jar"],"config":d["config"],"executionPassed":d["passed"],"error":d.get("error"),"cleanup":d["cleanup"],"stages":[]}
    gc_files=list(path.parent.glob("gc*.log"))
    text="\n".join(f.read_text(encoding="utf-8") for f in gc_files)
    gc=[]
    for line in text.splitlines():
        m=re.search(r"^\[([^]]+)\].*Pause.* ([\d.]+)ms$",line)
        if m:gc.append({"at":m[1],"pauseMs":float(m[2])})
    for s in d["stages"]:
        if "result" not in s:continue
        active=next((i for i,v in enumerate(s["accounting"]) if v["requests"]>0),0)
        b=s["before"][active]["limiter"];c=s["after"][active]["limiter"]
        item={"activeLabel":s["before"][active]["label"],"name":s["name"],"mode":s["diagnostics"],"startedAt":s["driverStartedAt"],"completedAt":s["completedAt"],
            "durationSeconds":s["durationSeconds"],"assessment":s["assessment"],"accounting":s["accounting"],"load":{k:s["result"][k] for k in ["offered","issued","finished","schedulerMisses","capacityMisses","statuses","transportErrors","latencyMs","successfulRequestsPerSecond","peakInFlight"]}}
        if "experimentProbe" in c:
            before=b["experimentProbe"];after=c["experimentProbe"];timings={}
            item["probeEnabled"]=after["enabled"]
            for k,v in after["timings"].items():
                old=before["timings"][k];n=v["count"]-old["count"];nanos=v["totalNanos"]-old["totalNanos"]
                h={"count":n,"totalNanos":nanos,"upperBoundsNanos":v["upperBoundsNanos"],"buckets":[i-j for i,j in zip(v["buckets"],old["buckets"])]}
                assert sum(h["buckets"])==n,(s["name"],k,"duration count mismatch")
                timings[k]={**h,"meanUs":nanos/max(n,1)/1000,"p95UpperBoundMs":percentile_bound(h,95),"p99UpperBoundMs":percentile_bound(h,99),"lifetimeMaxMs":v["maxNanos"]/1e6}
            item["timings"]=timings
            item["reasons"]={k:v-before["reasons"][k] for k,v in after["reasons"].items()}
            item["rejections"]={k:v-before["rejections"][k] for k,v in after["rejections"].items()}
            if after["enabled"]:
                assert sum(item["reasons"].values())==c["decisionsCompleted"]-b["decisionsCompleted"]
                assert sum(item["rejections"].values())==item["reasons"]["queue_full"]
            for key in ["saturationSamples","slowSamples","roundtripSamples"]:
                rows={json.dumps(v,sort_keys=True):v for v in s.get(key,[])+after.get(key,[]) if instant(v["at"])>=instant(s["driverStartedAt"])}
                item[key]=sorted(rows.values(),key=lambda v:v["at"])
            item["workerPhasesAtSaturation"]=dict(collections.Counter(w["phase"] for sample in item["saturationSamples"] for w in sample["workers"]))
        def commandstats(text):
            result={}
            for line in text.splitlines():
                if line.startswith("cmdstat_"):
                    key,value=line.split(":",1);result[key]=dict(x.split("=",1) for x in value.split(","))
            return result
        old,new=commandstats(s["redisBefore"]),commandstats(s["redisAfter"]);cmd={}
        for name in ["cmdstat_eval","cmdstat_evalsha","cmdstat_get","cmdstat_hgetall"]:
            vals={k:float(new.get(name,{}).get(k,0))-float(old.get(name,{}).get(k,0)) for k in ["calls","usec"]}
            vals["meanExecutionUs"]=vals["usec"]/max(1,vals["calls"]);cmd[name]=vals
        item["redisCommands"]=cmd
        active_log=path.parent/("gc-"+s["before"][active]["label"]+".log")
        selected_gc=gc
        if active_log.exists():
            selected_gc=[]
            for line in active_log.read_text(encoding="utf-8").splitlines():
                m=re.search(r"^\[([^]]+)\].*Pause.* ([\d.]+)ms$",line)
                if m:selected_gc.append({"at":m[1],"pauseMs":float(m[2])})
        matched=[v for v in selected_gc if instant(item["startedAt"])<=instant(v["at"])<=instant(item["completedAt"])]
        item["gc"]={"count":len(matched),"totalPauseMs":sum(v["pauseMs"] for v in matched),"maxPauseMs":max([v["pauseMs"] for v in matched] or [0])}
        item["nativeCheckpoints"]=[e for e in s["events"]]
        row["stages"].append(item)
    runs.append(row)
result={"runs":runs,"notes":["This is diagnosis, not production capacity acceptance.","Histograms are fixed non-cumulative buckets; percentiles are upper bounds, maxima are lifetime maxima.","Redis roundtrip includes client scheduling and transport; Redis INFO commandstats measures server execution separately.","Saturation/slow samples are bounded and rate limited; sample composition is not population share.","No-periodic-observer stages still contain experiment counters and identical GC logs; do not call them zero-instrumentation.","Comparison phase order controls some warmup drift but does not randomize host scheduling."]}
output=Path(a.output) if a.output else root/"analysis.json"
output.write_text(json.dumps(result,indent=2,ensure_ascii=False)+"\n",encoding="utf-8")
for r in runs:
    for s in r["stages"]:
        print(json.dumps({"run":Path(r["source"]).parent.name,"stage":s["name"],"requests":s["load"]["finished"],"failOpen":s["assessment"]["limiterFailOpen"],"rejections":s.get("rejections"),"gcMaxMs":s["gc"]["maxPauseMs"]}))
