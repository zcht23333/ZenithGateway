"""Independently check completed phases; preserve warmup/diagnostic failures and raw report."""
import argparse,collections,datetime,hashlib,json,statistics
from pathlib import Path

p=argparse.ArgumentParser();p.add_argument('report');p.add_argument('output');a=p.parse_args()
source=Path(a.report);target=Path(a.output)
if source.resolve()==target.resolve():p.error('Refuse to overwrite raw evidence')
raw=json.loads(source.read_text(encoding='utf-8-sig'));rows=[]
def timestamp(value):return datetime.datetime.fromisoformat(value.replace('Z','+00:00')).timestamp()
for s in raw['stages']:
    if 'result' not in s:continue
    r=s['result'];active=s['activeLabel'];c=next(x for x in s['accounting'] if x['label']==active)
    assert r['offered']==r['issued']+r['schedulerMisses']+r['capacityMisses']
    assert r['issued']==r['finished']==c['requests']
    assert sum(c['proxyReasons'].values())==c['requests']
    assert sum(c['limiterOutcomes'].values())==sum(c['limiterReasons'].values())==c['requests']
    assert c['limiterReasons']['queue_full']==c['limiterRejections']['admission_full']+c['limiterRejections']['executor_rejected']
    fail=sum(n for k,n in c['limiterOutcomes'].items() if 'fail_open' in k)
    missing=(r['schedulerMisses']+r['capacityMisses'])/r['offered']
    h=r['statusLatencyMs'].get('200',{});issues=[]
    if r['transportErrors'] or any(k!='200' and n for k,n in r['statuses'].items()):issues.append('response_error')
    if fail:issues.append('fail_open')
    if missing>.01:issues.append('generator_gap')
    if h.get('p95',float('inf'))>50 or h.get('p99',float('inf'))>100 or r['scheduledLatencyMs'].get('p99',float('inf'))>150:issues.append('latency')
    if s['samplingErrors']:issues.append('sampling')
    if any(c[k] for k in ['dropped','uncertain','reconciliationGap','monitorGap','auditGap']):issues.append('audit')
    if s['assessment']['resourceBreaches']:issues.append('resources')
    assert (not issues)==s['assessment']['healthy'],(s['name'],issues,s['assessment'])
    b=next(x for x in s['before'] if x['label']==active)['limiter'];end=next(x for x in s['after'] if x['label']==active)['limiter']
    times={}
    for name,v in end['observations']['timings'].items():
        old=b['observations']['timings'][name];n=v['count']-old['count'];ns=v['totalNanos']-old['totalNanos']
        assert sum(x-y for x,y in zip(v['buckets'],old['buckets']))==n
        times[name]={'count':n,'meanMicroseconds':ns/n/1000 if n else None}
    events=s.get('saturationSamples',[]);eventReasons=collections.Counter(e['reason'] for e in events)
    io=collections.Counter();delivery=collections.Counter();states=collections.Counter();resumed=[];oldest=[]
    for event in events:
        st=event['state'];io.update(st['ioPhases']);delivery.update(st['resultPhases'])
        for t in st['workerOwners']:
            states[(t['ioPhase'],t.get('ioThreadState','unknown'))]+=1
            if t['ioPhase']=='redis_wait' and t.get('replyObservedAgeMs') is not None:resumed.append(t['replyObservedAgeMs'])
        oldest.extend(x['ageMs'] for x in st['oldestTasks'])
    samples=[x for x in s['samples'] if x['label']==active]
    memory={}
    for name,field,sub in [('rss','rssBytes','processMemory'),('heap','heapBytes','jvm'),('direct','directBytes','jvm')]:
        values=[(timestamp(x['at'])-timestamp(s['driverStartedAt']),x.get(sub,{}).get(field)) for x in samples]
        values=[(t,v/1048576) for t,v in values if v is not None]
        if values:
            first=[v for t,v in values if t<=min(300,s['durationSeconds']/3)]
            last=[v for t,v in values if t>=max(t for t,v in values)-min(300,s['durationSeconds']/3)]
            memory[name]={'samples':len(values),'peakMiB':max(v for t,v in values),'earlyMedianMiB':statistics.median(first or [values[0][1]]),'lateMedianMiB':statistics.median(last)}
    peaks={k:max((x['limiter'][k] for x in samples),default=None) for k in ['commandsInFlight','queued','activeDeliveries','queuedDeliveries','retainedTasks']}
    rows.append({'name':s['name'],'kind':s['kind'],'label':active,'rate':s['arrivalRate'],'seconds':s['durationSeconds'],'healthy':not issues,'issues':issues,
        'requests':r['finished'],'successfulRps':r['successfulRequestsPerSecond'],'statuses':r['statuses'],'transportErrors':r['transportErrors'],
        'failOpen':fail,'queueFull':c['limiterReasons']['queue_full'],'rejections':c['limiterRejections'],'proxyReasons':{k:v for k,v in c['proxyReasons'].items() if v},
        'p95ms':h.get('p95'),'p99ms':h.get('p99'),'scheduledP99ms':r['scheduledLatencyMs']['p99'],'generatorMissFraction':missing,
        'upstreamReceived':s['upstreamReceived'],'audit':{k:c[k] for k in ['received','persisted','dropped','uncertain','pending','auditGap','monitorGap']},
        'timingMeans':times,'eventEvidence':{'retained':len(events),'reasons':dict(eventReasons),'ioTaskObservations':dict(io),'resultTaskObservations':dict(delivery),
            'workerStates':{'/'.join(k):v for k,v in states.items()},'replyObservedWhileWaitingCount':len(resumed),'maxObservedReplyToStageAdvanceMs':max(resumed,default=None),
            'maxOldestTaskAgeMs':max(oldest,default=None),'collectorTrimmed':s.get('collectorTrimmed',0),'cursorGaps':s.get('eventCursorGaps',[])},'sampledPeaks':peaks,'memory':memory,'drainSeconds':r['drainSeconds']})
result={'source':str(source.resolve()),'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'harnessCompleted':raw.get('passed',False),
    'artifact':raw['jar'],'rows':rows,'selected':raw.get('selected'),'longValidated':raw.get('longValidated'),'soakSkipped':raw.get('soakSkipped'),
    'requestsAllCompletedPhases':sum(x['requests'] for x in rows),'note':'Per-mode per-phase quantiles are not averaged. Saturation events are sampled, not a census; stage/thread/GC association is not exclusive causal attribution.'}
target.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
for x in rows:print(json.dumps({k:x[k] for k in ['name','requests','healthy','failOpen','p99ms','generatorMissFraction']}))
