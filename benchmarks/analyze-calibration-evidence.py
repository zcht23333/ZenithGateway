"""Correlate bounded saturation samples with GC safepoints; association is not causation."""
import argparse, collections, datetime, json, re, statistics
from pathlib import Path

p=argparse.ArgumentParser();p.add_argument('root');a=p.parse_args()
root=Path(a.root);raw=json.loads((root/'calibration/summary.json').read_text(encoding='utf-8-sig'))
def epoch(s): return datetime.datetime.fromisoformat(s.replace('Z','+00:00')).timestamp()*1000

def read_gc(label):
    rows=[]
    for f in sorted((root/'calibration').glob('gc-'+label+'.log*')):
        for line in f.read_text(encoding='utf-8').splitlines():
            t=re.match(r'\[([^]]+)\]',line)
            if not t:continue
            total=re.search(r'Total: (\d+) ns',line)
            if total:
                end=epoch(t[1]);duration=int(total[1])/1e6
                rows.append({'endMs':end,'startMs':end-duration,'durationMs':duration,'line':line})
    return rows

gc={label:read_gc(label) for label in ['A','B']};phases=[];events=[]
for s in raw['stages']:
    if 'result' not in s:continue
    label=s['activeLabel'];start=epoch(s['driverStartedAt']);end=start+s['durationSeconds']*1000
    pauses=[x for x in gc[label] if start<=x['endMs']<=end]
    sample=s['samples'];active=[x for x in sample if x['label']==label]
    resources={}
    for key in ['cpuFraction','threads','openFiles','heapBytes','nonHeapBytes','directBytes']:
        values=[x.get('jvm',{}).get(key) for x in active];values=[x for x in values if x is not None]
        if values:resources[key]={'min':min(values),'max':max(values),'median':statistics.median(values),'first':values[0],'last':values[-1]}
    phases.append({'name':s['name'],'safepoints':len(pauses),'safepointTotalMs':sum(x['durationMs'] for x in pauses),'maxSafepointMs':max((x['durationMs'] for x in pauses),default=0),'sampledJvm':resources})
    for event in s.get('saturationSamples',[]):
        st=event['state'];t=event['epochMillis'];near=[x for x in gc[label] if x['startMs']<=t+50 and x['endMs']>=t-250]
        active_delivery=[x for x in st['oldestTasks'] if x['resultPhase']=='delivery']
        events.append({'phase':s['name'],'label':label,'sequence':event['sequence'],'at':datetime.datetime.fromtimestamp(t/1000,datetime.timezone.utc).isoformat(),
            'afterLoadStartMs':t-start,'reason':event['reason'],'availablePermits':st['availablePermits'],'ioQueued':st['ioQueued'],'resultQueued':st['resultQueued'],
            'commandsInFlight':st['commandsInFlight'],'activeDeliveries':st['activeDeliveries'],'activeInlineDeliveries':st['activeInlineDeliveries'],
            'ioPhases':st['ioPhases'],'resultPhases':st['resultPhases'],'oldestTaskMs':max((x['ageMs'] for x in st['oldestTasks']),default=0),
            'ioOwners':st['workerOwners'],'oldestActiveDeliveries':active_delivery,'nearbySafepointsMinus250Plus50Ms':near})
output={'phases':phases,'events':events,'note':'Rejection point is sampled after the admission decision. Snapshots are non-atomic. Nearby safepoints do not establish exclusive cause; thread state is not OS run-queue latency. Oldest details cover the oldest 8 among at most 256 inspected tasks. Process CPU is the JVM reported fraction for its effective CPUs; not whole-host CPU.'}
(root/'saturation-gc-analysis.json').write_text(json.dumps(output,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'phases':len(phases),'events':len(events),'byPhase':dict(collections.Counter(x['phase'] for x in events))}))
