// Re-evaluate immutable capacity evidence and exercise the actual runner shutdown branch.
// This runs only two small exit-code containers, NOT another gateway or capacity load.
import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {createHash,randomUUID} from 'node:crypto'
import {assessCapacity} from '../benchmarks/conservative-capacity-gates.mjs'
import {recordCapacityShutdown} from '../benchmarks/conservative-capacity-shutdown.mjs'
import {images} from './acceptance-plan.mjs'

if(process.argv.length!==4)throw Error('Usage: node verification/conservative-capacity-p2-live.mjs <original-experiment-dir> <new-output-dir>')
const source=resolve(process.argv[2]),out=resolve(process.argv[3]),base=fileURLToPath(new URL('../',import.meta.url)),id=randomUUID().slice(0,8)
const exec=promisify(execFile),sha=data=>createHash('sha256').update(data).digest('hex'),owned=[]
const docker=async(args,options={})=>(await exec('docker',args,{windowsHide:true,timeout:15000,maxBuffer:4*1024*1024,...options})).stdout.trim()
const save=()=>writeFile(join(out,'validation.json'),JSON.stringify(report,null,2)+'\n')
const report={startedAt:new Date().toISOString(),id,source,out,passed:false,
 scope:'Recheck original raw data with current gates plus real isolated exit-code containers. Management acknowledgement is a fixture; no gateway traffic, Redis or one-hour rerun.',
 originalStages:[],alteredCopies:[],exitFixtures:[],cleanup:{}}
await mkdir(out,{recursive:false})
async function inventory(){
 const containers=(await docker(['ps','-a','--no-trunc','--format','{{json .}}'])).split('\n').filter(Boolean).map(s=>{
  const c=JSON.parse(s);return {id:c.ID,name:c.Names,state:c.State}
 }).sort((a,b)=>a.id.localeCompare(b.id))
 const volumes=(await docker(['volume','ls','-q'])).split('\n').filter(Boolean).sort()
 const bridge=JSON.parse(await docker(['network','inspect','bridge']))[0]
 return {at:new Date().toISOString(),containers,volumes,bridge:{id:bridge.Id,created:bridge.Created}}
}
try{
 const raw=await readFile(join(source,'summary.json')),original=JSON.parse(raw)
 report.sourceIdentity={summarySha256:sha(raw),jar:original.jar,experimentId:original.id,originalPassed:original.passed}
 report.gates={};await mkdir(join(out,'tools'))
 for(const path of ['benchmarks/conservative-capacity-gates.mjs','benchmarks/conservative-capacity-shutdown.mjs','benchmarks/conservative-capacity.mjs','verification/conservative-capacity-p2-live.mjs','verification/acceptance-plan.mjs']){
  const data=await readFile(join(base,path));report.gates[path]=sha(data);await writeFile(join(out,'tools',path.replaceAll('/','__')),data)
 }
 for(const key of ['maxMissFraction','p95Ms','p99Ms','scheduledP99Ms'])assert(Number.isFinite(original.config?.[key]),'Missing archived gate threshold '+key)
 report.thresholds=Object.fromEntries(['maxMissFraction','p95Ms','p99Ms','scheduledP99Ms'].map(key=>[key,original.config[key]]))
 const oldPath=join(source,'tools','conservative-capacity-gates.mjs'),oldBytes=await readFile(oldPath)
 report.originalGateSha256=sha(oldBytes)
 const oldGate=(await import(pathToFileURL(oldPath).href)).assessCapacity
 for(const stage of original.stages.filter(s=>s.result)){
  report.originalStages.push({name:stage.name,finished:stage.result.finished,samples:stage.samples.length,
   responseVersions:stage.result.versions,expected:{instanceId:stage.before[0].limiter.instanceId,runtimeVersion:stage.before[0].runtime.adoptedVersion,routeVersion:stage.before[0].route.adoptedVersion},
   recordedAssessment:stage.assessment,currentAssessment:assessCapacity(stage,original.config)})
 }
 const hour=original.stages.find(s=>s.name==='one-hour-1000');assert(hour,'Missing original hourly sample')
 for(const [name,mutate] of [
  ['missing_response_coverage',s=>{s.result.versions={}}],
  ['incomplete_response_coverage',s=>{s.result.versions[Object.keys(s.result.versions)[0]]--}],
  ['mixed_response_versions',s=>{s.result.versions[Object.keys(s.result.versions)[0]]--;s.result.versions['different-route:99']=1}],
  ['intermediate_runtime_version',s=>{s.samples[Math.floor(s.samples.length/2)].runtime.adoptedVersion='different-runtime:99'}],
  ['intermediate_route_failure',s=>{s.samples[Math.floor(s.samples.length/2)].route.status='failed'}],
  ['intermediate_runtime_stale',s=>{s.samples[Math.floor(s.samples.length/2)].runtime.stale=true}],
  ['intermediate_instance_change',s=>{s.samples[Math.floor(s.samples.length/2)].limiter.instanceId='other-instance'}],
  ['failure_recovered_between_samples',s=>{s.samples[Math.floor(s.samples.length/2)].route.failures++}]
 ]){
  const copy=structuredClone(hour);mutate(copy)
  report.alteredCopies.push({name,scope:'In-memory mutation of archived raw data, not a live experiment',previousAssessment:oldGate(copy,original.config),currentAssessment:assessCapacity(copy,original.config)})
 }
 assert(report.originalStages.length>0&&report.originalStages.every(s=>s.currentAssessment.healthy),'Original window no longer passes')
 assert(report.alteredCopies.every(s=>!s.currentAssessment.healthy),'Altered evidence incorrectly passed')
 report.hostBefore=await inventory()
 report.image={reference:images.node,id:await docker(['image','inspect',images.node,'--format','{{.Id}}'])}
 const runner=await readFile(join(base,'benchmarks/conservative-capacity.mjs'),'utf8')
 const begin=runner.indexOf('for(const g of gateways){',runner.lastIndexOf('finally{')),end=runner.indexOf('if(redisPort)',begin)
 assert(begin>0&&end>begin)
 const fragment=runner.slice(begin,end),AsyncFunction=Object.getPrototypeOf(async function(){}).constructor
 await writeFile(join(out,'actual-cleanup-fragment.txt'),fragment)
 for(const code of [0,23]){
  const name='zg-capacity-p2-'+id+'-exit-'+code,dir=join(out,'exit-'+code);await mkdir(dir);owned.push(name)
  const containerId=await docker(['run','-d','--pull=never','--name',name,'--label','zenith.capacity-p2.owner='+id,'--network','none','--cpus=0.5','--memory=128m','--pids-limit=64',images.node,'node','-e','process.exit('+code+')'])
  const actual={passed:true,cleanup:{}},processState={exitCode:0},fixture={containerId,name,expectedExit:code,report:actual,process:processState}
  report.exitFixtures.push(fixture)
  const scopedDocker=async(args,options)=>{assert(['wait','inspect','logs'].includes(args[0]));assert(args.includes(name));return docker(args,options)}
  await new AsyncFunction('api','docker','report','gateways','writeFile','join','out','process','recordCapacityShutdown','save',fragment)(
   async(g,path,options)=>{assert.equal(path,'/actuator/shutdown');assert.equal(options.method,'POST');return {scope:'simulated management acknowledgement'}},
   scopedDocker,actual,[{label:'A',name}],writeFile,join,dir,processState,recordCapacityShutdown,
   ()=>writeFile(join(dir,'cleanup.json'),JSON.stringify(actual,null,2)+'\n'))
  assert.equal(actual.cleanup.AShutdown.wait.exitCode,code);assert.equal(actual.cleanup.AShutdown.inspection.state.ExitCode,code)
  assert.equal(actual.cleanup.AGraceful,code===0);assert.equal(actual.passed,code===0);assert.equal(processState.exitCode,code===0?0:1)
  fixture.passed=true
 }
 report.sourceUnchanged=sha(await readFile(join(source,'summary.json')))===report.sourceIdentity.summarySha256
 assert(report.sourceUnchanged);report.passed=true
}catch(e){report.error=e.stack;process.exitCode=1}
finally{
 report.cleanup.containers=[]
 for(const name of owned.reverse()){
  try{
   const owner=await docker(['inspect','--format','{{index .Config.Labels "zenith.capacity-p2.owner"}}',name]);assert.equal(owner,id)
   await docker(['rm','-fv',name]);report.cleanup.containers.push({name,removed:true})
  }catch(e){report.cleanup.containers.push({name,removed:false,error:e.message});report.passed=false;process.exitCode=1}
 }
 if(report.hostBefore)try{
  report.hostAfter=await inventory()
  report.cleanup.ownedContainersAbsent=(await docker(['ps','-a','-q','--filter','label=zenith.capacity-p2.owner='+id]))===''
  report.cleanup.existingContainersUnchanged=JSON.stringify(report.hostBefore.containers)===JSON.stringify(report.hostAfter.containers)
  report.cleanup.volumesUnchanged=JSON.stringify(report.hostBefore.volumes)===JSON.stringify(report.hostAfter.volumes)
  report.bridgeChanged=report.hostBefore.bridge.id!==report.hostAfter.bridge.id
  assert(report.cleanup.ownedContainersAbsent&&report.cleanup.existingContainersUnchanged&&report.cleanup.volumesUnchanged,'Resource preservation or cleanup failed')
 }catch(e){report.cleanup.error=e.stack;report.passed=false;process.exitCode=1}
 report.finishedAt=new Date().toISOString();await save()
 console.log(JSON.stringify({out,passed:report.passed,stages:report.originalStages.length,alteredCopies:report.alteredCopies.length,exitFixtures:report.exitFixtures.map(f=>({code:f.expectedExit,passed:f.passed})),cleanup:report.cleanup},null,2))
}
