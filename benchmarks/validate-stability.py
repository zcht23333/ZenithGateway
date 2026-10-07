"""Verify experiment provenance and accounting without relabeling degraded load as healthy."""
import argparse,hashlib,json
from datetime import datetime
from pathlib import Path

def ts(s):return datetime.fromisoformat(s.replace("Z","+00:00")).timestamp()
def main():
    p=argparse.ArgumentParser();p.add_argument("root",type=Path);p.add_argument("--output",required=True,type=Path);a=p.parse_args()
    if a.output.exists():raise SystemExit("Refusing to overwrite previous validation")
    plan=json.loads((a.root/"plan.json").read_text(encoding="utf-8-sig"))
    names=["cold-i1","cold-g1","cold-g2","cold-i2","cold-i3","cold-g3","longevity"]
    runs={n:json.loads((a.root/n/"summary.json").read_text(encoding="utf-8-sig")) for n in names}
    checks=[]
    def check(name,value,detail=None):checks.append({"name":name,"passed":bool(value),**({"detail":detail} if detail is not None else {})})
    check("frozen_jar",hashlib.sha256((a.root/"baseline.jar").read_bytes()).hexdigest()==plan["frozenJarSha256"] and all(r["jar"]["sha256"]==plan["frozenJarSha256"] for r in runs.values()))
    check("fresh_run_identity",len({r["id"] for r in runs.values()})==len(runs))
    check("predeclared_cold_order",[runs[n]["config"]["coldStrategy"] for n in names[:-1]]==plan["cold"]["order"])
    check("same_measured_harness",len({json.dumps(r["harnessIdentity"],sort_keys=True) for r in runs.values()})==1)
    observations=[]
    for n,r in runs.items():
        check(n+"/execution",r["passed"] and not r.get("error"))
        check(n+"/limits",r["config"]["workers"]==8 and r["config"]["queueCapacity"]==128 and r["config"]["applicationProfile"]=="capacity")
        check(n+"/cleanup",r["cleanup"].get("networkRemoved") and r["cleanup"].get("credentialRemoved") and not (a.root/n/"secrets").exists() and all(r["cleanup"].get(g["label"]+"Graceful") for g in r["gateways"]))
        for s in r["stages"]:
            if "result" not in s:continue
            q=s["result"]
            valid=q["offered"]==q["issued"]+q["schedulerMisses"]+q["capacityMisses"] and q["issued"]==q["finished"]
            valid=valid and sum(q["statuses"].values())+q["transportErrors"]==q["finished"]
            valid=valid and q["elapsedSeconds"]>=s["durationSeconds"]
            valid=valid and all(v["offered"]==v["issued"]+v["schedulerMisses"]+v["capacityMisses"] and v["issued"]==v["finished"] for v in q["segmentStats"].values())
            valid=valid and sum(x["requests"] for x in s["accounting"])==q["finished"]+len(s["probes"])
            valid=valid and all(x["reconciliationGap"]==x["auditGap"]==x["monitorGap"]==0 for x in s["accounting"])
            check(n+"/"+s["name"]+"/accounting",valid)
            check(n+"/"+s["name"]+"/observation",not s["samplingErrors"] and not s["assessment"]["resourceBreaches"])
            observations.append({"run":n,"stage":s["name"],"healthy":s["assessment"]["healthy"],"issues":s["assessment"]["issues"],
              "offered":q["offered"],"issued":q["issued"],"statuses":q["statuses"],"transportErrors":q["transportErrors"],
              "schedulerMisses":q["schedulerMisses"],"capacityMisses":q["capacityMisses"],"limiterFailOpen":s["assessment"]["limiterFailOpen"]})
        if r["phase"]=="cold":
            s=r["stages"][0];target=s["result"]["segmentStats"]["target"]
            check(n+"/common_target",target["durationSeconds"]==60 and target["arrivalRate"]==2000 and target["offered"]==120000)
            check(n+"/two_instances",len(r["gateways"])==2 and all(x>0 for x in s["readyToDriverMs"].values()))
    r=runs["longevity"];s=next(x for x in r["stages"] if x["name"]=="hour")
    check("longevity/full_hour",s["durationSeconds"]==3600 and s["result"]["offered"]==14400000)
    check("longevity/phase_order",[x["name"] for x in r["stages"]]==["warmup","hour","idle-after-hour","reload","idle-after-reload"])
    check("longevity/idle_durations",[x["durationSeconds"] for x in r["stages"] if x.get("kind")=="idle"]==[600,120])
    check("longevity/reload_duration",next(x for x in r["stages"] if x["name"]=="reload")["durationSeconds"]==300)
    checkpoints={x["label"]:x for x in r["memoryCheckpoints"]}
    expected=["after-warmup"]+["load-"+str(x) for x in range(300,3600,300)]+["end-hour","end-idle","before-interventions","after-System-trim_native_heap","after-GC-run"]
    check("longevity/checkpoints",set(checkpoints)==set(expected) and all("completedAt" in x for x in checkpoints.values()))
    interventions=r["diagnosticInterventions"]
    check("longevity/interventions_only_after_measurement",len(interventions)==2 and all(ts(x["startedAt"])>ts(r["stages"][-1]["completedAt"]) for x in interventions))
    result={"frozenJarSha256":plan["frozenJarSha256"],"checksPassed":all(x["passed"] for x in checks),"checks":checks,"observations":observations,
      "meaning":"checksPassed verifies experiment execution and evidence consistency. Workload health is reported separately; any limiter fail-open disqualifies a healthy-capacity claim.",
      "preservation":"Workspace and pre-existing container preservation require the separate end-of-run audit."}
    a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"output":str(a.output),"checksPassed":result["checksPassed"],"unhealthyStages":[x["run"]+"/"+x["stage"] for x in observations if not x["healthy"]]}))
    if not result["checksPassed"]:raise SystemExit(1)
if __name__=="__main__":main()
