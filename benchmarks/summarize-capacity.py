"""Aggregate explicit capacity runs without averaging percentiles or hiding failed load levels."""
import argparse, collections, json, math, statistics
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("reports", nargs="+", type=Path)
parser.add_argument("--output", required=True, type=Path)
args = parser.parse_args()
if args.output.exists():
    raise SystemExit("Refusing to overwrite an existing capacity summary")
rows = []
runs = []
def extent(values):
    values = [x for x in values if isinstance(x, (int, float)) and math.isfinite(x)]
    return {"samples": len(values), "min": min(values), "median": statistics.median(values), "max": max(values)} if values else {"samples": 0}
for path in args.reports:
    report = json.loads(path.read_text(encoding="utf-8-sig"))
    runs.append({"path": str(path.resolve()), "phase": report["phase"], "executionPassed": report["passed"],
                 "error": report.get("error"), "jar": report["jar"], "config": report["config"],
                 "environment": report.get("environment"), "cleanup": report.get("cleanup")})
    for stage in report["stages"]:
        if "result" not in stage:
            continue
        r = stage["result"]
        accounts = stage.get("accounting", [])
        outcomes = collections.Counter()
        for a in accounts:
            outcomes.update(a["limiterOutcomes"])
        groups = {}
        for label in sorted({s["label"] for s in stage["samples"]}):
            samples = [s for s in stage["samples"] if s["label"] == label]
            groups[label] = {
                "heapBytes": extent([s["jvm"]["heapBytes"] for s in samples]),
                "directBytes": extent([s["jvm"]["directBytes"] for s in samples]),
                "rssBytes": extent([s.get("processMemory", {}).get("rssBytes") for s in samples]),
                "jvmCpuFraction": extent([s["jvm"]["cpuFraction"] for s in samples]),
                "threads": extent([s["jvm"]["threads"] for s in samples]),
                "auditPending": extent([s["audit"]["pending"] for s in samples]),
                "auditReservedBytes": extent([s["audit"]["reservedBytes"] for s in samples]),
                "limiterQueue": extent([s["limiter"]["queued"] for s in samples]),
                "limiterCommands": extent([s["limiter"]["commandsInFlight"] for s in samples]),
                "limiterConnections": extent([s["limiter"]["openConnections"] for s in samples]),
                "limiterScheduled": extent([s["limiter"]["scheduledTasks"] for s in samples]),
                "proxyConnections": extent([s["proxy"]["pool"].get("total.connections") for s in samples]),
                "proxyPending": extent([s["proxy"]["pool"].get("pending.connections") for s in samples]),
            }
            if stage["durationSeconds"] >= 900:
                thirds = []
                for i in range(3):
                    part = samples[len(samples)*i//3:len(samples)*(i+1)//3]
                    thirds.append({"heap": extent([s["jvm"]["heapBytes"] for s in part]),
                                   "rss": extent([s.get("processMemory", {}).get("rssBytes") for s in part]),
                                   "direct": extent([s["jvm"]["directBytes"] for s in part]),
                                   "threads": extent([s["jvm"]["threads"] for s in part]),
                                   "auditPending": extent([s["audit"]["pending"] for s in part])})
                groups[label]["chronologicalThirds"] = thirds
        rows.append({"source": str(path.resolve()), "phase": report["phase"], "stage": stage["name"],
                     "workers": report["config"]["workers"], "queueCapacity": report["config"].get("queueCapacity",64), "routes": report["config"]["routeCount"],
                     "durationSeconds": r["durationSeconds"], "offeredRate": r["arrivalRate"],
                     "offered": r["offered"], "issued": r["issued"], "finished": r["finished"],
                     "generatorMisses": r["schedulerMisses"] + r["capacityMisses"],
                     "missPercent": 100*(r["schedulerMisses"] + r["capacityMisses"])/r["offered"],
                     "successfulRequestsPerSecond": r["successfulRequestsPerSecond"],
                     "http200LatencyMs": r["statusLatencyMs"].get("200"), "statuses": r["statuses"],
                     "transportErrors": r["transportErrors"], "limiterOutcomes": dict(outcomes),
                     "auditConfirmed": sum(a["persisted"] for a in accounts),
                     "auditDropped": sum(a["dropped"] for a in accounts),
                     "auditUncertain": sum(a["uncertain"] for a in accounts),
                     "accountingGaps": [a[k] for a in accounts for k in ["monitorGap", "auditGap", "reconciliationGap"]],
                     "assessment": stage.get("assessment"), "events": stage["events"],
                     "resources": groups, "driverCpuCores": extent([s["cpuCores"] for s in r["samples"]]),
                     "jfr": stage.get("jfr")})
result = {"runs": runs, "stages": rows,
          "interpretation": ["HTTP 200 throughput is not healthy limiter throughput when any fail-open occurs.",
                             "Do not average percentile values across samples; raw per-run histograms remain the source.",
                             "Memory/connection numbers are sampled observations, not proof against all leaks or hidden resources.",
                             "Warmups and JFR runs are not unprofiled capacity comparisons.",
                             "These CPU sets share one Docker Desktop VM and host; no production capacity claim."]}
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
print(json.dumps({"output": str(args.output), "runs": len(runs), "stages": len(rows)}))
