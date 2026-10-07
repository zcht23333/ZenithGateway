import {scopedDockerArgs} from '../verification/acceptance-scope.mjs'
// Executes the committed alerts and the ACTUAL dashboard PromQL against independent fixtures.
// No business server or frontend build required. Docker runs only pinned promtool and removes itself.
import assert from 'node:assert/strict'
import {readFile,writeFile,mkdtemp,rm,chmod} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {fileURLToPath} from 'node:url'
import {resolve,join,dirname,basename} from 'node:path'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
const root=fileURLToPath(new URL('..',import.meta.url))
const image='prom/prometheus:v3.13.3@sha256:6976aa8a60fec930796ce5772b8d12da7a318a5daa8d40d69c5c7819a05eeed7'
const source=await readFile(join(root,'observability/grafana/dashboards/zenith.json'),'utf8'),d=JSON.parse(source)
const panels=new Map(d.panels.map(p=>[p.id,p]))
assert.equal(panels.size,d.panels.length)
const variable=d.templating.list.find(v=>v.name==='instance')
assert(variable.multi&&variable.includeAll&&variable.query.query==='label_values(up{job="zenith-gateway"}, instance)')
const targets=d.panels.flatMap(p=>(p.targets||[]).map(t=>({panel:p.id,ref:t.refId,expr:t.expr})))
for(const t of targets){
 assert(t.expr.includes('instance=~"$instance"'),t.panel+' must respect instance selection')
 assert(!/or\s+vector\(0\)/.test(t.expr),'Missing data must not be filled with an invented zero')
}
for(const p of d.panels.filter(p=>p.type==='stat')){
 assert.deepEqual(p.options.reduceOptions.calcs,['last'],'Current stat must not retain a last non-null value across a scrape failure')
 assert(p.targets.every(t=>t.instant),'Current stats must query the current instant')
}
const expr=(id,ref='A',instance='A')=>panels.get(id).targets.find(t=>t.refId===ref).expr.replaceAll('$instance',instance)
const sample=(labels,value)=>({labels,value})
const metric=(event,action,execution,values,i='A')=>({series:'zenith_ratelimit_decisions_total{job="zenith-gateway",instance="'+i+'",event="'+event+'",action="'+action+'",execution="'+execution+'"}',values})
const up=(i='A',values='1+0x24')=>({series:'up{job="zenith-gateway",instance="'+i+'"}',values})
const rows=[
 metric('allowed','forward','confirmed','0+10x24'),
 metric('disabled','forward','not_sent','0+5x24'),
 metric('limited','reject','confirmed','0+5x24'),
 metric('unfulfillable','reject','confirmed','0+5x24'),
 metric('local_unavailable','forward','not_sent','0+5x24'),
 metric('redis_unconfirmed','reject','unknown','0+5x24'),
 metric('cancelled','cancel','unknown','0+5x24')]
const check=(id,expected,ref='A',instance='A')=>({expr:expr(id,ref,instance),eval_time:'1m',exp_samples:expected})
const one=v=>[sample('{instance="A"}',v)]
const tests=[
 {name:'Every dashboard query parses; absent targets stay absent',interval:'5s',input_series:[],promql_expr_test:targets.map(t=>({expr:t.expr.replaceAll('$instance','.*'),eval_time:'1m',exp_samples:[]}))},
 {name:'Actual dashboard classifications, overlapping unknown and precise ratio denominator',interval:'5s',input_series:[up(),up('B'),...rows,metric('allowed','forward','confirmed','0+5x24','B')],
 promql_expr_test:[
 check(18,[sample('{job="zenith-gateway",instance="A"}',1)]),
 ...[2,1,2,1,1,2].map((v,i)=>check(20+i,one(v))),
 check(27,one(12.5)),check(27,one(12.5),'B'),
 check(20,[sample('{instance="B"}',1)],'A','B'),
 check(20,[...one(2),sample('{instance="B"}',1)],'A','.*'),
 check(26,[sample('{instance="A",action="reject"}',1),sample('{instance="A",action="cancel"}',1)])
 ]},
 {name:'Existing request and decision latency histograms retain instance before gating and quantiles',interval:'5s',
 input_series:[up(),up('B'),...['zenith_gateway_requests_seconds_bucket','zenith_ratelimit_redis_seconds_bucket'].flatMap(name=>['A','B'].flatMap(instance=>['0.1',instance==='A'?'1':'2','+Inf'].map(le=>({series:name+'{job="zenith-gateway",instance="'+instance+'",le="'+le+'"}',values:le==='0.1'?'0+0x24':'0+10x24'}))))],
 promql_expr_test:[check(3,one(0.955)),check(8,one(0.55)),check(8,one(0.955),'B'),check(8,one(0.991),'C'),check(11,one(0.955)),check(11,one(0.991),'B'),
 check(3,[sample('{instance="B"}',1.905)],'A','B'),
 check(3,[...one(0.955),sample('{instance="B"}',1.905)],'A','.*')]},
 {name:'Zero business traffic has real zero counters, present data and undefined shares',interval:'5s',input_series:[up(),...rows.map(r=>({...r,values:'0+0x24'}))],
 promql_expr_test:[check(18,[sample('{job="zenith-gateway",instance="A"}',1)]),...[20,21,22,23,24,25].map(id=>check(id,one(0))),check(27,[]),check(27,[],'B')]},
 {name:'Scrape succeeds but no decision family is distinct from idle',interval:'5s',input_series:[up()],
 promql_expr_test:[check(18,[sample('{job="zenith-gateway",instance="A"}',2)]),...[20,21,22,23,24,25,27].map(id=>check(id,[]))]},
 {name:'A disappeared metric family gates trailing-window counters while scrape still succeeds',interval:'5s',input_series:[up(),...rows.map(r=>({...r,values:'0 5 10 15 20 25 stale'}))],
 promql_expr_test:[check(18,[sample('{job="zenith-gateway",instance="A"}',2)]),...[20,21,22,23,24,25,26,27].map(id=>check(id,[]))]},
 {name:'Existing audit and latency alerts without a job label remain visible in the alert table',interval:'5s',input_series:[{series:'ALERTS{alertname="ZenithAuditDropped",alertstate="firing",instance="A",severity="critical"}',values:'1+0x24'}],
 promql_expr_test:[check(17,[sample('ALERTS{alertname="ZenithAuditDropped",alertstate="firing",instance="A",severity="critical"}',1)])]},
 {name:'Scrape failure gates stale range counters and is shown explicitly',interval:'5s',input_series:[up('A','1+0x5 0+0x20'),...rows],
 promql_expr_test:[check(18,[sample('{job="zenith-gateway",instance="A"}',0)]),...[20,21,22,23,24,25,26,27].map(id=>check(id,[]))]}
]
const dir=await mkdtemp(join(tmpdir(),'zenith-monitoring-')),result={dashboardSha256:createHash('sha256').update(source).digest('hex'),dashboardPanels:d.panels.length,dashboardQueries:targets.length,dashboardCases:tests.length,dashboardAssertions:tests.reduce((s,t)=>s+t.promql_expr_test.length,0),ruleCases:0,ruleAssertions:0,image,passed:false}
function run(args,mount=join(root,'observability/prometheus')){
 return execFileSync('docker',scopedDockerArgs(['run','--rm','--pull=never','--entrypoint','/bin/promtool','-v',mount.replaceAll('\\','/')+':/checks:ro','-w','/checks',image,...args]),{encoding:'utf8',windowsHide:true,timeout:60000})
}
try{
 console.log(run(['check','rules','alerts.yml']))
 console.log(run(['test','rules','alerts.test.yml','limiter-alerts.test.yml']))
 for(const name of ['alerts.test.yml','limiter-alerts.test.yml']){
  const f=JSON.parse(await readFile(join(root,'observability/prometheus',name),'utf8'))
  result.ruleCases+=f.tests.length;result.ruleAssertions+=f.tests.reduce((s,t)=>s+(t.alert_rule_test?.length||0)+(t.promql_expr_test?.length||0),0)
 }
 // mkdtemp is 0700 on Linux; promtool runs as nobody. Only these public test inputs need read access.
 await chmod(dir,0o755)
 await writeFile(join(dir,'dashboard.test.yml'),JSON.stringify({rule_files:[],evaluation_interval:'5s',fuzzy_compare:true,tests},null,2))
 await chmod(join(dir,'dashboard.test.yml'),0o644)
 console.log(run(['test','rules','dashboard.test.yml'],dir))
 result.passed=true;console.log(JSON.stringify(result,null,2))
}finally{
 assert.equal(dirname(resolve(dir)),resolve(tmpdir()),'Temporary cleanup must remain inside the named temp directory')
 assert(basename(dir).startsWith('zenith-monitoring-'),'Only this runner owns the temporary directory')
 await rm(dir,{recursive:true,force:true})
 if(process.argv.includes('--report'))await writeFile(resolve(process.argv[process.argv.indexOf('--report')+1]),JSON.stringify(result,null,2)+'\n')
}
