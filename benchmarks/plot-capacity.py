"""Render measured capacity results. Requires matplotlib; never overwrites existing artifacts."""
import argparse, json
from pathlib import Path
from datetime import datetime
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

p = argparse.ArgumentParser()
p.add_argument("aggregate", type=Path)
p.add_argument("--output-dir", required=True, type=Path)
a = p.parse_args()
report = json.loads(a.aggregate.read_text(encoding="utf-8-sig"))
a.output_dir.mkdir(parents=True, exist_ok=False)
plt.rcParams.update({"font.size": 10, "axes.spines.top": False, "axes.spines.right": False,
                     "axes.grid": True, "grid.alpha": .18, "figure.facecolor": "#f6f8fa",
                     "axes.facecolor": "#ffffff", "savefig.facecolor": "#f6f8fa"})
rows = [s for s in report["stages"] if s["phase"] == "compare" and s["stage"].startswith("steady-")
        and s["offeredRate"] == 6000]
if rows:
    fig, axes = plt.subplots(2, 1, figsize=(12, 7), sharex=True, layout="constrained")
    labels = [f'{r["workers"]} workers\nqueue {r["queueCapacity"]}\n{r["stage"]}' for r in rows]
    colors = ["#087e68" if r["assessment"]["healthy"] else "#bd5b24" for r in rows]
    xs = list(range(len(rows)))
    p99 = [r["http200LatencyMs"]["p99"] for r in rows]
    fail = [r["assessment"]["limiterFailOpen"] for r in rows]
    axes[0].bar(xs, p99, color=colors, width=.62)
    for x, n in zip(xs, p99):
        axes[0].text(x, n+.1, f"{n:.2f}", ha="center", va="bottom")
    axes[0].set_ylabel("HTTP 200 P99 (ms)")
    axes[0].set_ylim(0, max(p99)*1.25)
    axes[1].bar(xs, fail, color=colors, width=.62)
    for x, n in zip(xs, fail):
        axes[1].text(x, n+1, str(n), ha="center", va="bottom")
    axes[1].set_ylabel("Limiter fail-open decisions")
    axes[1].set_xticks(xs, labels, fontsize=8)
    axes[1].set_ylim(0, max(1,max(fail))*1.22)
    fig.suptitle("6,000 offered requests/s: bounded queue comparison\n"
                 "60 s full-rate warmup + 3 consecutive 30 s samples per configuration", fontsize=14)
    fig.supxlabel("Green: healthy by declared criteria. Orange: HTTP 200 includes limiter fail-open.\n"
                  "One Docker Desktop host; consecutive samples are not independent JVM replications.", fontsize=9)
    fig.savefig(a.output_dir/"capacity-comparison.png", dpi=160)
    plt.close(fig)

soaks = [s for s in report["stages"] if s["phase"]=="soak" and s["stage"]=="sustained"]
for index, s in enumerate(soaks):
    raw = json.loads(Path(s["source"]).read_text(encoding="utf-8-sig"))
    stage = next(x for x in raw["stages"] if x["name"]=="sustained")
    start = datetime.fromisoformat(stage["driverStartedAt"].replace("Z","+00:00"))
    vals = [x for x in stage["samples"] if x["label"]=="A"]
    minutes = [(datetime.fromisoformat(x["at"].replace("Z","+00:00"))-start).total_seconds()/60 for x in vals]
    driver = [x for x in stage["result"]["samples"] if 1<=x["seconds"]<=stage["durationSeconds"]]
    fig, axes = plt.subplots(4,1,figsize=(12,10),sharex=True,layout="constrained")
    axes[0].plot([x["seconds"]/60 for x in driver], [x["requestsPerSecond"] for x in driver],
                 color="#276fc2", linewidth=.8, label="Completed / second")
    axes[0].axhline(stage["arrivalRate"],color="#697482",linestyle="--",linewidth=1,label="Offered rate")
    axes[0].set_ylabel("Requests/s")
    axes[0].legend(loc="lower right")
    mib = 1024*1024
    axes[1].plot(minutes,[x["jvm"]["heapBytes"]/mib for x in vals],color="#276fc2",linewidth=.9,label="Heap used")
    rss = [(t,x["processMemory"]["rssBytes"]/mib) for t,x in zip(minutes,vals) if "processMemory" in x]
    axes[1].plot([x[0] for x in rss],[x[1] for x in rss],color="#bc5129",linewidth=1.4,label="Process RSS")
    axes[1].set_ylabel("Memory (MiB)")
    axes[1].legend(loc="center right")
    direct=[x["jvm"]["directBytes"]/mib for x in vals]
    axes[2].plot(minutes,direct,color="#7748b8",linewidth=1.2,label="Direct buffers")
    axes[2].set_ylim(0,max(6,max(direct)*1.2))
    axes[2].set_ylabel("Direct (MiB)")
    threads=[x["jvm"]["threads"] for x in vals]
    axes[2].text(.01,.82,f"Observed threads: {min(threads):g} - {max(threads):g}",
                 transform=axes[2].transAxes)
    axes[3].plot(minutes,[x["audit"]["pending"] for x in vals],color="#087e68",linewidth=.9,label="Audit pending")
    axes[3].plot(minutes,[x["limiter"]["queued"] for x in vals],color="#bc5129",linewidth=.9,label="Limiter queued")
    axes[3].set_ylabel("Queued items")
    axes[3].set_xlabel("Minutes since measured load started")
    axes[3].legend(loc="upper right")
    for ax in axes: ax.set_xlim(0,stage["durationSeconds"]/60)
    fig.suptitle(f'{stage["durationSeconds"]//60}-minute measured load: {stage["arrivalRate"]:,} offered requests/s\n'
                 f'{raw["config"]["workers"]} limiter workers, queue {raw["config"].get("queueCapacity",64)}, '
                 f'{raw["config"]["routeCount"]} routes; limiter + monitoring + audit enabled',fontsize=14)
    fig.supxlabel("Gateway sampled about every 2 s; RSS about every 10 s. Sampling is not proof against all leaks.\n"
                  f'Issued {s["issued"]:,}; missed slots {s["generatorMisses"]:,}; '
                  f'limiter fail-open {s["assessment"]["limiterFailOpen"]:,}.',fontsize=9)
    fig.savefig(a.output_dir/("capacity-soak"+("" if index==0 else "-"+str(index+1))+".png"),dpi=150)
    plt.close(fig)
print(a.output_dir)
