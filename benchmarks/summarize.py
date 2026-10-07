"""Create a compact, reviewable JSON aggregate from explicit benchmark report paths."""
import argparse
import json
import statistics
from collections import defaultdict
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("reports", nargs="+", type=Path)
parser.add_argument("--output", required=True, type=Path)
args = parser.parse_args()
runs = []
groups = defaultdict(list)
for path in args.reports:
    report = json.loads(path.read_text(encoding="utf-8"))
    for scenario in report.get("scenarios", []):
        scenario.pop("samples", None)  # Full per-second samples stay in the original local report.
        groups[(report["workload"]["arrivalRate"], scenario["name"])].append(scenario)
    runs.append(report)

aggregates = []
for (arrival_rate, name), rows in groups.items():
    throughput = [row["requestsPerSecond"] for row in rows]
    aggregates.append({
        "arrivalRate": arrival_rate,
        "scenario": name,
        "repetitions": len(rows),
        "throughput": {
            "median": statistics.median(throughput),
            "min": min(throughput),
            "max": max(throughput),
        },
        "p95LatencyMsMedian": statistics.median(row["latencyMs"]["p95"] for row in rows),
        "p99LatencyMsMedian": statistics.median(row["latencyMs"]["p99"] for row in rows),
        "cpuFractionMedian": statistics.median(row["cpuFractionAverage"] for row in rows),
        "heapBytesPeakSampled": max(row["heapBytesPeakSampled"] for row in rows),
        "pendingPeakSampled": max(row["pendingPeakSampled"] for row in rows),
        "reservedBytesPeakSampled": max(row["reservedBytesPeakSampled"] for row in rows),
        "oldestAgeMsPeakSampled": max(row["oldestAgeMsPeakSampled"] for row in rows),
        "requestsTotal": sum(row["requests"] for row in rows),
        "auditReceivedTotal": sum(row["audit"]["received"] for row in rows),
        "auditConfirmedTotal": sum(row["audit"]["persisted"] for row in rows),
        "auditDroppedTotal": sum(row["audit"]["dropped"] for row in rows),
        "auditUncertainTotal": sum(row["audit"]["uncertain"] for row in rows),
        "schedulerMissesTotal": sum(row["schedulerMisses"] for row in rows),
        "capacityMissesTotal": sum(row["capacityMisses"] for row in rows),
        "transportErrorsTotal": sum(row["transportErrors"] for row in rows),
        "non200Total": sum(sum(count for status, count in row["statuses"].items() if status != "200") for row in rows),
        "accountingFailures": sum(bool(row["reconciliationGap"] or row["monitorGap"] or row["auditGap"]) for row in rows),
        "duplicateRetainedIds": sum(row["duplicateRetainedIds"] for row in rows),
        "samplingErrors": sum(len(row["samplingErrors"]) for row in rows),
    })
result = {"sourceReports": [path.as_posix() for path in args.reports], "aggregates": aggregates, "runs": runs}
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
for item in aggregates:
    print(f"{item['arrivalRate'] or 'closed'}/{item['scenario']}: "
          f"median={item['throughput']['median']:.1f}, "
          f"range={item['throughput']['min']:.1f}..{item['throughput']['max']:.1f}, "
          f"confirmed={item['auditConfirmedTotal']}, dropped={item['auditDroppedTotal']}, "
          f"uncertain={item['auditUncertainTotal']}")
