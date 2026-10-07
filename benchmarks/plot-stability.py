"""Render measured memory and cold-start evidence. Never overwrite prior figures."""
import argparse,json
from pathlib import Path
from datetime import datetime
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

def ts(s):return datetime.fromisoformat(s.replace("Z","+00:00")).timestamp()
def raw(run):return json.loads(Path(run["source"]).read_text(encoding="utf-8-sig"))
def save(fig,d,name):
    for ext in ["png","svg"]:fig.savefig(d/(name+"."+ext),dpi=170,facecolor="white",bbox_inches="tight")
    plt.close(fig)
def clean(ax,title,y):
    ax.set_title(title,loc="left",fontweight="bold",pad=12)
    ax.set_ylabel(y);ax.grid(axis="y",alpha=.18)
    ax.spines[["top","right"]].set_visible(False)
def memory_trends(run,d):
    r=raw(run);hour=next(s for s in r["stages"] if s["name"]=="hour");zero=ts(hour["driverStartedAt"])
    samples=[x for s in r["stages"] for x in s["samples"] if x["label"]=="A"]
    minutes=lambda x:(ts(x["at"])-zero)/60
    x=[minutes(v) for v in samples]
    fig,axes=plt.subplots(2,2,figsize=(14,8.8),layout="constrained")
    a,b,c,e=axes.flat
    for ax in axes.flat:
        for s in r["stages"]:
            start=ts(s.get("driverStartedAt",s["startedAt"]))
            end=ts(s["completedAt"])
            if s["name"]=="reload":ax.axvspan((start-zero)/60,(end-zero)/60,color="#dcebe9",alpha=.65,zorder=0)
            elif s.get("kind")=="idle":ax.axvspan((start-zero)/60,(end-zero)/60,color="#eeeeee",alpha=.8,zorder=0)
        ax.set_xlabel("Minutes from start of the 60-minute load")
    rss=[v for v in samples if "processMemory" in v]
    a.plot([minutes(v) for v in rss],[v["processMemory"]["rssBytes"]/2**20 for v in rss],color="#225e8f",lw=1.7,label="/proc status RSS")
    mem=run["memory"];mx=[(ts(v["at"])-zero)/60 for v in mem]
    a.scatter(mx,[v["rssKiB"]/1024 for v in mem],s=24,color="#ed8444",zorder=4,label="smaps_rollup checkpoints")
    b.plot(x,[v["jvm"]["heapBytes"]/2**20 for v in samples],color="#82b6aa",lw=.8,label="Heap used (dots: checkpoints)")
    b.plot(x,[v["jvm"]["heapCommitted"]/2**20 for v in samples],color="#303e4d",lw=1.2,label="Heap committed")
    b.plot(mx,[v["mappedMemory"]["javaHeap"]["rssKiB"]/1024 for v in mem],"o-",color="#ba682e",lw=1.3,ms=3,label="Heap resident pages (smaps)")
    b.scatter(mx,[v["heapUsedKiB"]/1024 for v in mem],s=15,color="#0d7068",zorder=5)
    c.plot(x,[v["jvm"]["directBytes"]/2**20 for v in samples],color="#128278",label="Direct buffer memory")
    c2=c.twinx();c2.plot(x,[v["jvm"]["threads"] for v in samples],color="#72579c",lw=1.4,label="Java threads")
    c2.set_ylabel("Java threads");c2.set_ylim(0,max(v["jvm"]["threads"] for v in samples)*1.3);c2.spines["top"].set_visible(False)
    c.set_ylim(0,max(v["jvm"]["directBytes"]/2**20 for v in samples)*1.5)
    for getter,label,color in [(lambda v:v["audit"]["pending"],"Audit pending","#225e8f"),
      (lambda v:v["limiter"]["queued"],"Limiter queued","#ed8444"),
      (lambda v:v["proxy"]["pool"].get("total.connections") or 0,"Total upstream connections","#72579c")]:
        e.plot(x,[getter(v) for v in samples],label=label,lw=.8,color=color)
    for it in r.get("diagnosticInterventions",[]):
        at=(ts(it["startedAt"])-zero)/60
        for ax in [a,b]:ax.axvline(at,color="#b44145",lw=.8,ls=":")
    clean(a,"Resident process memory","MiB")
    clean(b,"Heap allocation and physical residency","MiB")
    clean(c,"Direct memory and thread count","MiB")
    clean(e,"Work queues and upstream connections","Count (sampled)")
    for ax in [a,b,e]:ax.legend(loc="best",fontsize=8)
    b.set_ylim(0,300);b.legend(loc="upper left",fontsize=8)
    post={v["label"]:v for v in mem}
    trimmed=post.get("after-System-trim_native_heap");collected=post.get("after-GC-run")
    if trimmed and collected:
        tx=(ts(trimmed["at"])-zero)/60;ty=trimmed["rssKiB"]/1024
        a.annotate(f'Trim: {ty:.1f} MiB\nGC: {collected["rssKiB"]/1024:.1f} MiB',
          xy=(tx,ty),xytext=(tx-18,ty+12),fontsize=8,color="#7b3e26",
          arrowprops={"arrowstyle":"->","color":"#7b3e26","lw":.8})
    health=hour["assessment"]
    fig.supxlabel(f'Hour load: {health["limiterFailOpen"]:,} limiter fail-open decisions. Gray = idle; green = reload; red dotted = manual diagnostics.',fontsize=8.5)

    c.legend(loc="upper left",fontsize=8);c2.legend(loc="upper right",fontsize=8)
    fig.suptitle("ZenithGateway | 4,000 offered requests/s, one frozen JVM\n60 min load → 10 min idle → 5 min reload → 2 min idle → diagnostic trim / GC",fontsize=13,fontweight="bold")
    save(fig,d,"memory-timeline")

def native_breakdown(run,d):
    m=run["memory"];x=np.arange(len(m))
    names=[]
    for v in m:
        n=v["label"]
        names.append({"after-warmup":"Warm","end-hour":"60 min","end-idle":"+10m idle","before-interventions":"Reload+idle",
         "after-System-trim_native_heap":"Trim","after-GC-run":"GC"}.get(n,str(round(int(n[5:])/60))+" min" if n.startswith("load-") else n))
    fig,axes=plt.subplots(3,1,figsize=(14,11),layout="constrained")
    bottom=np.zeros(len(m))
    for k,label,color in [("javaHeap","Java heap RSS","#225e8f"),("codeCache","Code cache RSS","#e49a55"),
     ("file","File mappings RSS","#86a884"),("otherAnonymous","Other anonymous RSS","#8c83a2"),
     ("mainCHeap","Main C heap RSS","#ad595a"),("stack","Main stack RSS","#888888")]:
        y=np.array([v["mappedMemory"].get(k,{}).get("rssKiB",0)/1024 for v in m])
        axes[0].bar(x,y,bottom=bottom,label=label,color=color);bottom+=y
    axes[0].legend(ncol=3,fontsize=8,loc="upper left")
    axes[0].set_ylim(0,max(bottom)*1.22)
    clean(axes[0],"Process residency by mapped address range","MiB RSS")
    for key,label,color in [("systemCurrentBytes","Allocator arena space","#225e8f"),("freeBinBytes","Allocator free bins","#128278"),
     ("notInFreeBinsEstimateBytes","Arena space - free bins + mmap (estimate)","#ba682e")]:
        axes[1].plot(x,[v["allocator"][key]/2**20 for v in m],"o-",label=label,color=color,ms=3)
    clean(axes[1],"glibc allocator accounting (free bins are not resident bytes)","MiB")
    axes[1].legend(ncol=3,fontsize=8,loc="best")
    for key,label,color in [("Code","NMT Code committed","#e49a55"),("Metaspace","NMT Metaspace committed","#225e8f"),
     ("GC","NMT GC committed","#128278"),("Object Monitors","NMT Object Monitors","#8c83a2")]:
        axes[2].plot(x,[v["nmtCategories"].get(key,{}).get("committedKiB",0)/1024 for v in m],"o-",label=label,color=color,ms=3)
    clean(axes[2],"Selected HotSpot categories (NMT is not complete process accounting)","MiB committed")
    axes[2].legend(ncol=2,fontsize=8,loc="best")
    for ax in axes:
        ax.set_xticks(x,names,rotation=40,ha="right")
        if len(m)>=2:ax.axvspan(len(m)-2.5,len(m)-.5,color="#f3dede",alpha=.45,zorder=0)
    fig.suptitle("ZenithGateway | memory attribution checkpoints\nRed region: manual interventions after all measured traffic and idle phases",fontsize=13,fontweight="bold")
    save(fig,d,"memory-attribution")

def cold_figures(runs,d):
    order=sorted(runs,key=lambda r:(r["config"]["coldStrategy"]!="immediate",str(r["source"])))
    labels=[Path(r["source"]).parent.name for r in order]
    stages=[r["stages"][0] for r in order];x=np.arange(len(order))
    fig,axes=plt.subplots(2,1,figsize=(11,7.4),layout="constrained")
    counts=[s["load"]["statuses"].get("503",0) for s in stages]
    fail=[s["assessment"]["limiterFailOpen"] for s in stages]
    for xs,ys,label,col in [(x-.18,counts,"HTTP 503","#ad595a"),(x+.18,fail,"Limiter fail-open","#ed9a44")]:
        bars=axes[0].bar(xs,ys,width=.35,label=label,color=col);axes[0].bar_label(bars,padding=3)
    clean(axes[0],"Cold-start failures, all 120 seconds retained","Count")
    axes[0].set_xticks(x,labels);axes[0].set_ylim(0,max(counts+fail+[1])*1.24);axes[0].legend()
    initial=[];target=[]
    for s in stages:
        parts=s["load"]["segmentStats"]
        initial.append(sum(v.get("schedulerMisses",0)+v.get("capacityMisses",0) for k,v in parts.items() if k!="target"))
        target.append(parts["target"].get("schedulerMisses",0)+parts["target"].get("capacityMisses",0))
    for xs,ys,label,col in [(x-.18,initial,"First 60 s: planned requests not sent","#6c849c"),(x+.18,target,"Common final 60 s: planned requests not sent","#128278")]:
        bars=axes[1].bar(xs,ys,width=.35,label=label,color=col);axes[1].bar_label(bars,padding=3)
    clean(axes[1],"Generator misses remain visible","Count")
    axes[1].set_xticks(x,labels);axes[1].set_ylim(0,max(initial+target+[1])*1.25);axes[1].legend(fontsize=8)
    fig.suptitle("ZenithGateway | three fresh-JVM runs per strategy\nImmediate: 2,000/s throughout. Gradual: 100 → 500 → 1,000 → 2,000/s.",fontsize=13,fontweight="bold")
    fig.supxlabel("Rates are combined across two instances. Each run uses a new JVM pair; the final 60 seconds use 2,000/s.",fontsize=9)
    save(fig,d,"cold-start-comparison")
    chosen=max(order,key=lambda r:r["stages"][0]["load"]["statuses"].get("503",0))
    r=raw(chosen);s=r["stages"][0];z=ts(s["driverStartedAt"])
    vals=[v for v in s["samples"] if v["label"]=="B" and ts(v["at"])-z<=20]
    x=[ts(v["at"])-z for v in vals]
    fig,ax=plt.subplots(figsize=(11,4.8),layout="constrained")
    for k,label,color in [("active.connections","Active upstream connections","#225e8f"),("pending.connections","Pending connection acquisitions","#128278")]:
        ax.plot(x,[v["proxy"]["pool"].get(k) or 0 for v in vals],"o-",ms=2.5,label=label,color=color)
    failures=s["result"]["firstFailures"]
    for f in failures:ax.axvline(f["seconds"],ymin=0,ymax=.12,color="#ad595a",alpha=.18,lw=1)
    ax.axhline(100,color="#666666",ls=":",label="Configured connection / pending limit (each)")
    clean(ax,"Instance B, "+Path(chosen["source"]).parent.name+" | first 20 seconds","Count")
    ax.set_xlabel("Seconds after load driver started");ax.set_ylim(-2,120);ax.legend(fontsize=8)
    fig.suptitle("Connection-pool rejection evidence\nRed ticks: 503 completion times; sampling does not capture every transient maximum.",fontsize=12,fontweight="bold")
    save(fig,d,"cold-start-pool")

def main():
    p=argparse.ArgumentParser();p.add_argument("summary",type=Path);p.add_argument("--output",required=True,type=Path);a=p.parse_args()
    if a.output.exists():raise SystemExit("Refusing to overwrite an existing figure directory")
    data=json.loads(a.summary.read_text(encoding="utf-8-sig"))
    a.output.mkdir(parents=True)
    plt.rcParams.update({"font.family":"DejaVu Sans","font.size":9,"axes.titlesize":11,"axes.labelsize":9,"svg.fonttype":"none"})
    longs=[r for r in data["runs"] if r["phase"]=="longevity"]
    for r in longs:
        if len(longs)>1:raise SystemExit("Use a summary with only one longevity run")
        memory_trends(r,a.output);native_breakdown(r,a.output)
    cold=[r for r in data["runs"] if r["phase"]=="cold"]
    if cold:cold_figures(cold,a.output)
    print(json.dumps({"output":str(a.output),"files":[p.name for p in sorted(a.output.iterdir())]}))
if __name__=="__main__":main()
