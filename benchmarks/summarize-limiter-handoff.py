"""Summarize paired inline/handoff phases; never equate harness completion with healthy load."""
import argparse,json,hashlib
from pathlib import Path

parser=argparse.ArgumentParser()
parser.add_argument('report')
parser.add_argument('output')
args=parser.parse_args()
report=Path(args.report)
if report.resolve()==Path(args.output).resolve():parser.error('Output must not overwrite the raw report')
raw=json.loads(report.read_text(encoding='utf-8'))
rows=[]
for stage in raw['stages']:
    if 'result' not in stage:continue
    for accounting in stage['accounting']:
        if not accounting['requests']:continue
        label=accounting['label'];before=next(x for x in stage['before'] if x['label']==label)['limiter']
        after=next(x for x in stage['after'] if x['label']==label)['limiter']
        assert sum(accounting['limiterOutcomes'].values())==accounting['requests']
        reasons=accounting.get('limiterReasons') or {}
        rejections=accounting.get('limiterRejections') or {}
        assert sum(reasons.values())==accounting['requests']
        assert reasons.get('queue_full',0)==rejections.get('admission_full',0)+rejections.get('executor_rejected',0)
        assert rejections.get('delivery_rejected',0)==0
        times={}
        for key,end in after['observations']['timings'].items():
            start=before['observations']['timings'][key]
            count=end['count']-start['count'];ns=end['totalNanos']-start['totalNanos']
            buckets=[a-b for a,b in zip(end['buckets'],start['buckets'])]
            assert sum(buckets)==count and all(n>=0 for n in buckets)
            times[key]={'count':count,'meanMicroseconds':ns/count/1000 if count else None,'totalNanos':ns}
        samples=[x['limiter'] for x in stage['samples'] if x['label']==label]
        peaks={k:max((x[k] for x in samples),default=None) for k in [
            'commandsInFlight','activeWorkers','queued','activeDeliveries','queuedDeliveries','retainedTasks']}
        for x in samples:
            assert x['commandsInFlight']<=x['workers'] and x['queued']<=x['queueCapacity']
            assert x['openConnections']<=x['workers']
            if x['resultHandoffEnabled']:
                assert x['activeDeliveries']<=x['resultWorkers']
                assert x['retainedTasks']<=x['admissionCapacity']
                assert x['queuedDeliveries']<=x['deliveryQueueCapacity']
        r=stage['result']
        rows.append({'stage':stage['name'],'label':label,'warmup':stage['name'].startswith('warmup'),
            'handoff':after['resultHandoffEnabled'],'requests':accounting['requests'],
            'healthy':stage['assessment']['healthy'],'issues':stage['assessment']['issues'],
            'rps':r['successfulRequestsPerSecond'],'statuses':r['statuses'],
            'http200P95ms':r['statusLatencyMs'].get('200',{}).get('p95'),
            'http200P99ms':r['statusLatencyMs'].get('200',{}).get('p99'),
            'limiterReasons':reasons,'rejections':rejections,'timings':times,'observedPeaks':peaks,
            'auditGap':accounting['auditGap'],'monitorGap':accounting['monitorGap'],
            'auditDropped':accounting['dropped'],'auditUncertain':accounting['uncertain'],
            'generatorMisses':r['schedulerMisses']+r['capacityMisses'],'offered':r['offered']})
measured=[x for x in rows if not x['warmup']]
result={'source':str(report.resolve()),'sourceSha256':hashlib.sha256(report.read_bytes()).hexdigest(),
    'harnessCompleted':raw.get('passed',False),'allMeasuredPhasesHealthy':bool(raw.get('passed',False) and measured) and all(x['healthy'] for x in measured),
    'rows':rows,'requestsIncludingWarmup':sum(x['requests'] for x in rows),
    'failOpenIncludingWarmup':sum(sum(v for k,v in x['limiterReasons'].items() if k not in ['quota_available','disabled','quota_exhausted','cost_exceeds_capacity','client_cancelled']) for x in rows),
    'note':'Paired observations on a shared Docker Desktop host; phase mean wall times include scheduling. Observed peaks are sampled, not exact maxima. Warmups and failed phases retained.'}
Path(args.output).write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
for row in rows:
    print(json.dumps({k:row[k] for k in ['stage','requests','healthy','http200P95ms','http200P99ms','generatorMisses','rejections']},ensure_ascii=False))
