"""Render completed calibration evidence; never modifies the raw report."""
from pathlib import Path
import datetime,json,sys
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
root=Path(sys.argv[1]);raw=json.loads((root/'calibration/summary.json').read_text(encoding='utf-8-sig'))
assert raw.get('passed'),'Only render a completed evidence set'
plt.rcParams.update({'font.size':11,'axes.spines.top':False,'axes.spines.right':False,'figure.facecolor':'white','axes.facecolor':'white'})
colors={'A':'#17668b','B':'#be6c20'}
fig,axes=plt.subplots(1,2,figsize=(12,4.6))
for label in ['A','B']:
    rows=[s for s in raw['stages'] if s['kind']=='capacity' and s['activeLabel']==label]
    for ax,metric in zip(axes,['p99','gap']):
        xs=[];ys=[]
        for s in rows:
            r=s['result'];xs.append(s['arrivalRate']+(-16 if label=='A' else 16));ys.append(r['statusLatencyMs']['200']['p99'] if metric=='p99' else 100*(r['schedulerMisses']+r['capacityMisses'])/r['offered'])
        ax.scatter(xs,ys,label={'A':'A - inline (default)','B':'B - bounded handoff'}[label],color=colors[label],s=36,alpha=.8)
        ax.set_xlabel('Planned arrivals / second');ax.grid(alpha=.16);ax.set_ylim(bottom=0)
axes[0].set_ylabel('HTTP 200 P99 (ms)');axes[0].set_title('Repeated short-run latency');axes[0].legend()
all_short=[s for s in raw['stages'] if s['kind']=='capacity'];max_gap=max(100*(s['result']['schedulerMisses']+s['result']['capacityMisses'])/s['result']['offered'] for s in all_short);axes[1].set_ylim(0,max(.001,max_gap*1.15))
for ax in axes:
    assert all(ax.get_ylim()[0]<=y<=ax.get_ylim()[1] for collection in ax.collections for x,y in collection.get_offsets()),'Chart clips an observation'
axes[1].set_ylabel('Planned arrivals not issued (%)');axes[1].set_title('Generator arrival gap (limit: 1%)');axes[1].legend()
fig.suptitle('ZenithGateway - same final artifact, fixed resources',fontsize=15)
fig.text(.5,.01,'Two 120-second runs per mode and rate. Points are observations, not confidence intervals. Cold and diagnostic runs excluded.',ha='center',fontsize=9)
fig.tight_layout(rect=(0,.05,1,.95));fig.savefig(root/'capacity-short-results.png',dpi=160);plt.close(fig)
soaks=[s for s in raw['stages'] if s['kind']=='soak']
if soaks:
    s=soaks[0];start=datetime.datetime.fromisoformat(s['driverStartedAt'].replace('Z','+00:00')).timestamp();samples=[x for x in s['samples'] if x['label']==s['activeLabel']]
    def t(x):return (datetime.datetime.fromisoformat(x['at'].replace('Z','+00:00')).timestamp()-start)/60
    fig,axes=plt.subplots(5,1,figsize=(12,12),sharex=True)
    for field,label,color in [('heapBytes','Heap used','#17668b'),('directBytes','Direct buffer used','#7f47a8')]:axes[0].plot([t(x) for x in samples],[x['jvm'][field]/1048576 for x in samples],label=label,color=color,lw=.8)
    rss=[x for x in samples if x.get('processMemory',{}).get('rssBytes') is not None];axes[0].plot([t(x) for x in rss],[x['processMemory']['rssBytes']/1048576 for x in rss],label='Process RSS',color='#be6c20',lw=1)
    axes[0].set_ylabel('MiB');axes[0].legend(ncol=3);axes[0].set_ylim(bottom=0)
    for field,label,color in [('commandsInFlight','Observed commands','#17668b'),('queued','I/O queue','#be6c20'),('retainedTasks','Retained tasks','#6a8742')]:axes[1].plot([t(x) for x in samples],[x['limiter'][field] for x in samples],label=label,color=color,lw=.7)
    axes[1].set_ylabel('Sampled count');axes[1].legend(ncol=3);axes[1].set_ylim(bottom=0)
    base=next(x for x in s['before'] if x['label']==s['activeLabel'])['limiter']['outcomes'];baseline=base['redis_fail_open']+base['local_fail_open'];fail=s['assessment']['limiterFailOpen']
    axes[2].step([t(x) for x in samples]+[60],[x['limiter']['outcomes']['redis_fail_open']+x['limiter']['outcomes']['local_fail_open']-baseline for x in samples]+[fail],color='#ac3b31',where='post');axes[2].set_ylabel('Cumulative\nfail-open');axes[2].set_ylim(bottom=0)
    axes[3].plot([t(x) for x in samples],[100*x['jvm']['cpuFraction'] for x in samples],color='#17668b',lw=.8);axes[3].set_ylabel('JVM CPU (%)');axes[3].set_ylim(0,100)
    ds=s['result']['samples'];axes[4].plot([x['seconds']/60 for x in ds],[x['requestsPerSecond'] for x in ds],color='#17668b',lw=.8);axes[4].axhline(s['arrivalRate'],color='#777',ls='--',lw=.8);axes[4].set_ylabel('Completions / s');axes[4].set_xlabel('Elapsed minutes');axes[4].set_ylim(0,s['arrivalRate']*1.12)
    for ax in axes:ax.grid(alpha=.16);ax.set_xlim(0,60)
    fig.suptitle('One-hour run - '+s['activeLabel']+' / '+str(s['arrivalRate'])+' planned req/s\n'+('PASSED' if s['assessment']['healthy'] else 'NOT PASSED')+f': {fail:,} limiter fail-open decisions',fontsize=15)
    fig.text(.5,.01,'Resources sampled about every 2 s (RSS about every 10 s); counts are observations, not instantaneous maxima. Full results include missed arrivals and audit reconciliation.',ha='center',fontsize=8)
    fig.tight_layout(rect=(0,.035,1,.96));fig.savefig(root/'capacity-one-hour-resources.png',dpi=160);plt.close(fig)
print('Rendered capacity figures from completed raw evidence')
