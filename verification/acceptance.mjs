// One build-input snapshot, one frozen package, explicit results and bounded owned-resource cleanup.
import {readFile,writeFile,mkdir,copyFile,cp,stat} from 'node:fs/promises'
import {execFileSync} from 'node:child_process'
import {resolve,join,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {randomUUID} from 'node:crypto'
import {fileHash,json,snapshot,inventory,runCommand,commandFor,assertJar,reportPassed,parseNodeTests} from './acceptance-core.mjs'
import {images,requiredImages,releaseChecks,toolTests,validateLiveReport} from './acceptance-plan.mjs'
import {scopedDockerArgs} from './acceptance-scope.mjs'
import {docker,hostResources,cleanupScope,cleanupCredentials,auditHostResources} from './acceptance-cleanup.mjs'
const root=fileURLToPath(new URL('..',import.meta.url)),argv=process.argv.slice(2)
let tier='commit',out,allowDirty=false,imageMode='prepare',selfTestFailure
for(let n=0;n<argv.length;n++) {
 if(argv[n]==='--tier')tier=argv[++n]
 else if(argv[n]==='--out')out=resolve(argv[++n])
 else if(argv[n]==='--allow-dirty')allowDirty=true
 else if(argv[n]==='--images')imageMode=argv[++n]
 else if(argv[n]==='--self-test-failure')selfTestFailure=argv[++n]
 else throw new Error('Unknown argument: '+argv[n])
}
requiredImages(tier)
if(selfTestFailure&&!['exit','timeout'].includes(selfTestFailure))throw new Error('self-test-failure must be exit or timeout')
if(!['prepare','cached'].includes(imageMode))throw new Error('images must be prepare or cached')
out ||= resolve(root,'.dev/acceptance/'+tier+'-'+randomUUID())
await mkdir(dirname(out),{recursive:true});await mkdir(out) // Refuse an existing directory; never overwrite evidence.
const workspace=join(out,'workspace'),id='zg-'+randomUUID(),controller=new AbortController()
const report={schemaVersion:1,id,tier,startedAt:new Date().toISOString(),passed:false,plannedSteps:[],steps:[],
 faultInjection:selfTestFailure||null,
 notExecuted:['external load balancer rolling replacement','one-hour capacity validation','RSS attribution','standalone browser matrices'],cleanup:{passed:false}}
const env={...process.env,CI:'true'}
for(const key of Object.keys(env))if(/^(ZENITH_|SPRING_|CONFIG_.*_OUTPUT|RATE_LIMIT_|PROXY_RESILIENCE_|ROUTE_PUBLICATION_)/.test(key))delete env[key]
env.ZENITH_ACCEPTANCE_SCOPE=id;env.ZENITH_ACCEPTANCE_PROCESS_LEDGER=join(out,'owned-java.jsonl')
const save=()=>json(join(out,'report.json'),report)
let redisName,baseline
const signal=()=>controller.abort(new Error('Acceptance interrupted'))
process.once('SIGINT',signal);process.once('SIGTERM',signal)
async function step(name,command,args,{timeoutMs=300000,extraEnv={},validate}={}) {
 if(controller.signal.aborted)throw new Error('Acceptance interrupted')
 const row={name,status:'running',startedAt:new Date().toISOString(),command,args,log:'logs/'+name+'.log'}
 report.steps.push(row);await save();console.log('START '+name)
 try {
  Object.assign(row,await runCommand(command,args,{cwd:workspace,env:{...env,...extraEnv},log:join(out,row.log),timeoutMs,signal:controller.signal}))
  if(!row.passed)throw new Error('Command failed: '+name+' exit='+row.exitCode+' timeout='+row.timedOut)
  if(validate)row.result=await validate()
  row.status='passed';console.log('PASS '+name)
 }catch(e){row.status='failed';row.error=e.stack;throw e}
 finally{row.completedAt=new Date().toISOString();await save()}
}
function native(kind,args){return commandFor(kind,args)}
try {
 report.plannedSteps=['toolchain-java','toolchain-maven',...requiredImages(tier).map((_,i)=>'image-'+i),'source-archive','backend','frontend-install','frontend-test','frontend-build','tool-tests','monitoring',...(tier==='release'?releaseChecks.map(c=>c.id):[])]
 const git=(...args)=>execFileSync('git',['-c','safe.directory='+root,...args],{cwd:root,encoding:'utf8',windowsHide:true,timeout:10000}).trim()
 const status=git('status','--porcelain=v1','--untracked-files=all'),commit=git('rev-parse','HEAD'),commitEpoch=git('log','-1','--format=%ct')
 if(status&&!allowDirty)throw new Error('Working tree is dirty. Commit it for release, or explicitly use --allow-dirty for a labelled workspace snapshot.')
 report.source={commit,dirty:!!status,allowDirty,commitEpoch,status}
 await mkdir(workspace);Object.assign(report.source,await snapshot(root,workspace));await json(join(out,'source-manifest.json'),report.source)
 const requiredNode=(await readFile(join(workspace,'.node-version'),'utf8')).trim()
 if(process.versions.node!==requiredNode)throw new Error('Node '+requiredNode+' required, got '+process.versions.node)
 if(!env.JAVA_HOME)throw new Error('JAVA_HOME must identify JDK 21')
 report.toolchains={node:process.version,platform:process.platform,arch:process.arch,javaHome:env.JAVA_HOME}
 baseline=hostResources();await json(join(out,'host-before.json'),baseline)
 await mkdir(join(out,'logs'));await mkdir(join(out,'artifacts'));await mkdir(join(out,'checks'))
 await step('toolchain-java',join(env.JAVA_HOME,'bin',process.platform==='win32'?'java.exe':'java'),['-version'],{timeoutMs:20000,validate:async()=>{
  const log=await readFile(join(out,'logs/toolchain-java.log'),'utf8');if(!/version "21\.0\.12\.1"/.test(log))throw new Error('Expected pinned JDK 21.0.12.1');return {version:log.trim()}
 }})
 await step('toolchain-maven',...native('maven',['-version']),{timeoutMs:180000,validate:async()=>{
  const log=await readFile(join(out,'logs/toolchain-maven.log'),'utf8');if(!log.includes('Apache Maven 3.9.16'))throw new Error('Maven wrapper must resolve 3.9.16');return {version:log.trim()}
 }})
 for(const [i,image] of requiredImages(tier).entries())await step('image-'+i,'docker',imageMode==='prepare'?['pull',image]:['image','inspect',image],{timeoutMs:180000})
 report.images={mode:imageMode,required:requiredImages(tier)}
 await step('source-archive','tar',['-cf',join(out,'artifacts/source.tar'),'-C',workspace,'.'],{timeoutMs:30000})
 report.source.archiveSha256=await fileHash(join(out,'artifacts/source.tar'))
 redisName='zenith-acceptance-'+id.slice(3,11)
 docker(...scopedDockerArgs(['run','-d','--pull=never','--name',redisName,'--cpus','1','--memory','512m','--pids-limit','128','--tmpfs','/data:rw,size=16m','-p','127.0.0.1::6379',images.redis,'--save','','--appendonly','no'],env))
 const inspected=JSON.parse(docker('inspect',redisName))[0],port=inspected.NetworkSettings.Ports['6379/tcp'][0].HostPort
 await json(join(out,'unit-redis.json'),{id:inspected.Id,name:redisName,port,inspect:inspected})
 env.ZENITH_TEST_REDIS_PORT=port
 if(selfTestFailure) {
  report.plannedSteps.splice(report.plannedSteps.indexOf('backend'),0,'injected-failure')
  await step('injected-failure',process.execPath,['-e',selfTestFailure==='exit'?"console.error('intentional acceptance exit failure');process.exit(71)":"console.log('intentional acceptance timeout');setInterval(()=>{},1000)"],{timeoutMs:500})
  throw new Error('Fault injection unexpectedly returned success')
 }
 try {
  await step('backend',...native('maven',['-B','-ntp','-f','backend/pom.xml','-Dproject.build.outputTimestamp='+commitEpoch,'clean','verify']),{timeoutMs:600000,validate:async()=>{
   const text=await readFile(join(out,'logs/backend.log'),'utf8'),m=[...text.matchAll(/Tests run: (\d+), Failures: (\d+), Errors: (\d+), Skipped: (\d+)/g)].at(-1)
   if(!m||+m[1]===0||m.slice(2).some(x=>+x!==0))throw new Error('Backend must execute tests with no failure/error/skip')
   return {tests:+m[1],failures:+m[2],errors:+m[3],skipped:+m[4]}
  }})
 }finally{
  await cp(join(workspace,'backend/target/surefire-reports'),join(out,'checks/backend'),{recursive:true}).catch(()=>{})
  docker('rm','-fv',redisName);redisName=null;delete env.ZENITH_TEST_REDIS_PORT
 }
 const jar=join(workspace,'backend/target/zg-1.0.0.jar'),jarSha256=await fileHash(jar)
 await copyFile(jar,join(out,'artifacts/gateway.jar'));report.artifacts={jarSha256}
 await step('frontend-install',...native('npm',['--prefix','frontend','ci','--no-audit','--no-fund']),{timeoutMs:300000})
 const tap=async name=>parseNodeTests(await readFile(join(out,'logs/'+name+'.log'),'utf8'))
 await step('frontend-test',...native('npm',['--prefix','frontend','test']),{validate:()=>tap('frontend-test')})
 await step('frontend-build',...native('npm',['--prefix','frontend','run','build']))
 await cp(join(workspace,'frontend/dist'),join(out,'artifacts/frontend'),{recursive:true});report.artifacts.frontend=await inventory(join(out,'artifacts/frontend'))
 await step('tool-tests',process.execPath,['--test','--test-reporter=tap',...toolTests],{validate:()=>tap('tool-tests')})
 await step('monitoring',process.execPath,['observability/test-monitoring.mjs','--report',join(out,'checks/monitoring.json')],{validate:async()=>{
  const r=JSON.parse(await readFile(join(out,'checks/monitoring.json'),'utf8'));if(!r.passed)throw new Error('Monitoring not passed');return r
 }})
 if(tier==='release')for(const check of releaseChecks) {
  await assertJar(jar,jarSha256);await assertJar(join(out,'artifacts/gateway.jar'),jarSha256)
  const dir=join(out,'checks',check.id),args=['verification/'+check.entry,...(check.backendOnly?['--backend-only']:[]),...(check.mode?['--mode',check.mode,'--jar',jar,'--out',dir]:[])]
  const extraEnv={...(check.output?{[check.output]:dir}:{}),RATE_LIMIT_HANDOFF:'false',PROXY_RESILIENCE_LIMITER_HANDOFF:'false'}
  await step(check.id,process.execPath,args,{extraEnv,timeoutMs:check.timeoutMs,validate:async()=>{
   const result=validateLiveReport(JSON.parse(await readFile(join(dir,'report.json'),'utf8')),check,jarSha256)
   await assertJar(jar,jarSha256)
   result.ownership=await cleanupScope(id)
   if(!result.ownership.passed)throw new Error('Resources remained after '+check.id)
   return result
  }})
 }
 await assertJar(jar,jarSha256);await assertJar(join(out,'artifacts/gateway.jar'),jarSha256)
 for(const input of report.source.files)if(await fileHash(join(workspace,input.path))!==input.sha256)throw new Error('A check changed build input: '+input.path)
 report.source.inputsUnchangedAfterChecks=true
}catch(error){report.error=error.stack;console.error(error.message)}
finally {
 for(const name of report.plannedSteps)if(!report.steps.some(s=>s.name===name))report.steps.push({name,status:'not_run',reason:'An earlier step failed or the run was interrupted'})
 try {
  report.cleanup=await cleanupScope(id,{force:true})
  report.cleanup.credentials=await cleanupCredentials(out)
  report.cleanup.forced ||= report.cleanup.credentials.removed.length>0
  if(baseline){report.hostAfter=hostResources();await json(join(out,'host-after.json'),report.hostAfter);report.cleanup.hostAudit=auditHostResources(baseline,report.hostAfter);report.cleanup.passed &&= report.cleanup.hostAudit.passed}
 }catch(error){report.cleanup={passed:false,error:error.stack}}
 if(controller.signal.aborted)report.error ||= 'Acceptance interrupted by signal'
 report.completedAt=new Date().toISOString();report.passed=reportPassed(report);await save()
 const summary=['# ZenithGateway '+tier+' acceptance','',report.passed?'PASS':'FAIL','',
  'Source: '+(report.source?.commit||'unavailable')+'; dirty='+report.source?.dirty,
  'Input SHA-256: '+(report.source?.sha256||'unavailable'),'JAR SHA-256: '+(report.artifacts?.jarSha256||'not built'),'',
  '| Step | Result | Executed | Evidence |','| --- | --- | --- | --- |',...report.steps.map(s=>{const r=s.result||{},count=r.tests? r.tests+' tests':r.checks?r.checks+' checks':r.ruleAssertions?r.ruleAssertions+r.dashboardAssertions+' assertions':'—';return '| '+s.name+' | '+s.status+' | '+count+' | '+(s.log?'['+s.name+']('+s.log+')':'not run')+' |'}),'',
  'Cleanup: '+(report.cleanup.passed?'confirmed':'NOT confirmed'),'',
  'Not executed: '+report.notExecuted.join('; '),
  'This acceptance run does not execute a capacity hour. The published 1000 req/s hour belongs only to its identified historical JAR and resources; long-term memory stability remains unproven, and the 4000 req/s hour remains failed.','',
  report.error?'Failure: '+report.error:'',''].join('\n')
 await writeFile(join(out,'summary.md'),summary)
 process.removeListener('SIGINT',signal);process.removeListener('SIGTERM',signal)
 if(!report.passed)process.exitCode=1
 console.log('Acceptance report: '+join(out,'report.json'))
}
