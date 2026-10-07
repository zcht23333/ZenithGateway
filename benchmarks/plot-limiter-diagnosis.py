"""Export the measured comparisons; values come only from the checked analysis file."""
import argparse,json
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
p=argparse.ArgumentParser();p.add_argument("analysis");p.add_argument("output");args=p.parse_args()
d=json.loads(Path(args.analysis).read_text(encoding="utf-8-sig"));out=Path(args.output);out.mkdir(parents=True,exist_ok=True)
observer=next(r for r in d["runs"] if r["config"].get("study","observer")=="observer")
transport=next(r for r in d["runs"] if r["config"].get("study")=="transport")
obs=[s for s in observer["stages"] if not s["name"].startswith("warmup")]
tr=[s for s in transport["stages"] if not s["name"].startswith("warmup")]
plt.rcParams.update({"font.family":"DejaVu Sans","font.size":10,"axes.spines.top":False,"axes.spines.right":False})
fig,(ax,bx)=plt.subplots(1,2,figsize=(13,5.2),layout="constrained")
names=["No polling 1","Polling 1","Native 1","Native 2","Polling 2","No polling 2"]
x=np.arange(len(obs));ys=[s["assessment"]["limiterFailOpen"] for s in obs]
bars=ax.bar(x,ys,color=["#478ca5","#478ca5","#c86e41","#c86e41","#478ca5","#478ca5"],width=.65)
for bar,y in zip(bars,ys):ax.annotate(str(y),(bar.get_x()+bar.get_width()/2,y),xytext=(0,5),textcoords="offset points",ha="center",weight="bold")
ax.set_xticks(x,names,rotation=30,ha="right");ax.set_ylabel("Local fail-open decisions")
ax.set_title("Queue overflow also occurs without periodic observers",loc="left",fontweight="bold",fontsize=11);ax.set_ylim(0,max(ys)*1.22+1)
ax.grid(axis="y",alpha=.18);ax.set_axisbelow(True)
bottom=np.zeros(len(tr));parts=[("connection","Connection","#cccccc"),("redis_roundtrip_and_resume","Redis roundtrip + resumption","#478ca5"),("decode","Decode","#86b493"),("delivery","Result delivery / downstream","#c86e41"),("cleanup","Cleanup","#c8b979")]
for key,label,color in parts:
    values=np.array([s["timings"][key]["meanUs"] for s in tr])
    bx.bar(np.arange(len(tr)),values,bottom=bottom,label=label,color=color,width=.6);bottom+=values
for i,v in enumerate(bottom):bx.annotate(f"{v:.0f}",(i,v),xytext=(0,5),textcoords="offset points",ha="center",weight="bold")
bx.set_xticks(range(len(tr)),["A relay 1","B direct 1","B direct 2","A relay 2"],rotation=25,ha="right")
bx.set_ylabel("Mean worker wall time per decision (microseconds)")
bx.set_title("Same Redis: limiter relay vs direct connection",loc="left",fontweight="bold",fontsize=11)
bx.set_ylim(0,max(bottom)*1.25);bx.grid(axis="y",alpha=.18);bx.set_axisbelow(True)
bx.legend(frameon=False,fontsize=8,loc="upper left")
fig.suptitle("ZenithGateway | limiter diagnosis at 4,000 offered req/s",fontsize=15,fontweight="bold")
fig.supxlabel("8 limiter workers / 128 waiting slots / 500 ms budget. Diagnostic samples, not a production capacity guarantee.",fontsize=9)
for suffix in ["png","svg"]:fig.savefig(out/("limiter-diagnosis-comparison."+suffix),dpi=150)
print(out/"limiter-diagnosis-comparison.png")
