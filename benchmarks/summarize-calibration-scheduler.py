"""Summarize per-thread /proc schedstat deltas in the bounded diagnostic pair."""
import collections, hashlib, json, re, sys
from pathlib import Path
source=Path(sys.argv[1]);raw=json.loads(source.read_text(encoding='utf-8-sig'))
def parse(s):
    threads={};cpu={};flags=[];clock=None
    for line in s['raw'].splitlines():
        if line.startswith('THREAD '):
            tid,name,run,wait,slices=line[7:].split('|');threads[tid]=(name,int(run),int(wait),int(slices))
        elif line.startswith('CLOCK '):clock=int(line.split()[1])
        elif line.startswith('SCHEDSTATS '):flags.append(int(line.split()[1]))
        else:
            fields=line.removeprefix('CPU ').split()
            if len(fields)==2 and fields[1].isdigit():cpu[fields[0]]=int(fields[1])
    return threads,cpu,flags,clock

def group(name):
    if name.startswith('rate-limit-io'):return 'limiter_io'
    if name.startswith('rate-limit-resu'):return 'limiter_result'
    if name.startswith('lettuce-epoll'):return 'redis_event_loop'
    if name.startswith('reactor-http'):return 'http_event_loop'
    return 'other'

modes={}
for label,samples in raw['modes'].items():
    if len(samples)<2:continue
    first,fc,ff,begin=parse(samples[0]);last,lc,lf,end=parse(samples[-1]);rows=[];groups={}
    for tid,t in last.items():
        if tid not in first or t[0]!=first[tid][0]:continue
        d=[t[i]-first[tid][i] for i in range(1,4)]
        assert min(d)>=0,('counter regression',label,tid)
        name=group(t[0]);g=groups.setdefault(name,{'threads':0,'runNs':0,'waitNs':0,'slices':0})
        g['threads']+=1;g['runNs']+=d[0];g['waitNs']+=d[1];g['slices']+=d[2]
        rows.append({'tid':tid,'name':t[0],'group':name,'runSeconds':d[0]/1e9,'runqueueWaitSeconds':d[1]/1e9,'slices':d[2]})
    modes[label]={'samples':len(samples),'observedSeconds':(end-begin)/1000,'globalSchedstatsFlags':sorted({v for x in samples for v in parse(x)[2]}),
        'collectionElapsedMs':[x['elapsedMs'] for x in samples],'truncated':any('TRUNCATED' in x['raw'] for x in samples),
        'cgroupDelta':{k:lc[k]-v for k,v in fc.items() if k in lc},'groups':{k:{'threads':v['threads'],'runSeconds':v['runNs']/1e9,'runqueueWaitSeconds':v['waitNs']/1e9,'slices':v['slices'],'meanRunqueueWaitMicrosecondsPerSlice':v['waitNs']/v['slices']/1000 if v['slices'] else None} for k,v in groups.items()},'threads':rows,
        'onlyFirst':sorted(set(first)-set(last)),'onlyLast':sorted(set(last)-set(first))}
result={'source':str(source.resolve()),'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'errors':raw['errors'],'modes':modes,
    'note':'Only common thread IDs with unchanged names are compared over the actual first-to-last observation window. CPU/wait sums span concurrent threads. A per-dispatch mean is not a request latency percentile or a maximum scheduling delay. Global sched_schedstats=0 does not disable CONFIG_SCHED_INFO counters in the observed WSL 6.6.87.2 source. No sysctl changed.'}
source.with_name('scheduler-analysis.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
for k,v in modes.items():print(json.dumps({'mode':k,'seconds':v['observedSeconds'],'groups':{g:s for g,s in v['groups'].items() if g.startswith('limiter_')},'throttledUsec':v['cgroupDelta'].get('throttled_usec')}))
