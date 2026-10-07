"""Independent accounting, source-preservation and cleanup checks for a completed diagnosis."""
import argparse,hashlib,json,subprocess,xml.etree.ElementTree as ET
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument("root");args=p.parse_args()
root=Path(args.root).resolve();base=Path(__file__).resolve().parent.parent;checks=[]
def check(name,value,details=None):
    checks.append({"check":name,"passed":bool(value),"details":details})
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
before=json.loads((root/"preservation-before.json").read_text(encoding="utf-8-sig"))
changes=[r["path"] for r in before["files"] if not (base/r["path"]).is_file() or sha(base/r["path"])!=r["sha256"]]
check("pre_existing_files_unchanged",not changes,{"count":len(before["files"]),"changes":changes})
now=[json.loads(x) for x in subprocess.check_output(["docker","ps","-a","--format","{{json .}}"],text=True,encoding="utf-8").splitlines()]
by_name={x["Names"]:x for x in now}
check("pre_existing_container_ids_and_states_unchanged",all(x["Names"] in by_name and all(x[k]==by_name[x["Names"]][k] for k in ["ID","State"]) for x in before["containers"]),{"count":len(before["containers"])})
all_stages=[];sources={"observer-comparison":"observer-sources","transport-comparison":"transport-sources","roundtrip-direct":"roundtrip-sources"}
for name,archive in sources.items():
    report=json.loads((root/name/"summary.json").read_text(encoding="utf-8-sig"));all_stages.extend(report["stages"])
    check(name+"/completed",report["passed"] and not report.get("error"))
    check(name+"/jar_frozen",sha(Path(report["jar"]["path"]))==report["jar"]["sha256"])
    check(name+"/measured_harness_archived",all(sha(root/archive/k)==v for k,v in report["harnessIdentity"].items()))
    check(name+"/owned_cleanup",report["cleanup"].get("networkRemoved") and report["cleanup"].get("credentialRemoved") and not (root/name/"secrets").exists())
    check(name+"/no_owned_container_remaining",all("zenith.limiter-diagnosis.owner="+report["id"] not in x.get("Labels","") for x in now))
    if name=="transport-comparison":
        proof=report["transportProof"]
        check(name+"/redis_peer_treatment_verified",len(proof)==2 and all(len(r["connections"])==8 and all(c["addr"].startswith(r["expectedRedisPeerIp"]+":") for c in r["connections"]) for r in proof))
    for s in report["stages"]:
        r=s["result"]
        valid=r["offered"]==r["issued"]+r["schedulerMisses"]+r["capacityMisses"] and r["issued"]==r["finished"]
        valid=valid and not r["transportErrors"] and r["statuses"]=={"200":r["finished"]}
        valid=valid and not s["samplingErrors"] and not s["assessment"]["resourceBreaches"]
        for i,row in enumerate(s["accounting"]):
            valid=valid and all(row[k]==0 for k in ["pending","dropped","uncertain","retries","reconciliationGap","monitorGap","auditGap"])
            valid=valid and row["requests"]==sum(row["limiterOutcomes"].values())
            b=s["before"][i]["limiter"];a=s["after"][i]["limiter"]
            bp=b["experimentProbe"];ap=a["experimentProbe"]
            reasons={k:ap["reasons"][k]-bp["reasons"][k] for k in ap["reasons"]}
            valid=valid and sum(reasons.values())==row["requests"]
            valid=valid and reasons["queue_full"]==row["limiterOutcomes"]["local_fail_open"] and row["limiterOutcomes"]["redis_fail_open"]==0
            valid=valid and sum(ap["rejections"][k]-bp["rejections"][k] for k in ap["rejections"])==reasons["queue_full"]
            valid=valid and all(len(ap.get(k,[]))<=128 for k in ["saturationSamples","slowSamples","roundtripSamples"])
            for k,v in ap["timings"].items():
                valid=valid and sum(v["buckets"])==v["count"]
        check(name+"/"+s["name"]+"/request_reason_audit_reconciliation",valid,{"requests":r["finished"],"failOpen":s["assessment"]["limiterFailOpen"],"healthy":s["assessment"]["healthy"]})
fixture=root/"production-fixture/target/surefire-reports/TEST-com.zch.ratelimit.WorkerOccupancyTest.xml"
t=ET.parse(fixture).getroot()
check("production_code_worker_fixture",t.attrib["tests"]=="1" and t.attrib["failures"]=="0" and t.attrib["errors"]=="0" and t.attrib["skipped"]=="0")
source=Path("src/main/java/com/zch/ratelimit/RedisRateLimiter.java")
check("fixture_uses_unchanged_limiter",sha(root/"production-fixture"/source)==sha(base/"backend"/source))
result={"passed":all(c["passed"] for c in checks),"checks":checks,"stageCount":len(all_stages),"totalRequests":sum(s["result"]["finished"] for s in all_stages),"totalFailOpen":sum(s["assessment"]["limiterFailOpen"] for s in all_stages),"note":"Verification of evidence integrity is separate from healthy capacity. All degraded stages remain included."}
(root/"integrity-validation.json").write_text(json.dumps(result,indent=2,ensure_ascii=False)+"\n",encoding="utf-8")
print(json.dumps({"passed":result["passed"],"checks":len(checks),"stages":len(all_stages),"requests":result["totalRequests"],"failOpen":result["totalFailOpen"],"failed":[c for c in checks if not c["passed"]]},ensure_ascii=False))
raise SystemExit(0 if result["passed"] else 1)
