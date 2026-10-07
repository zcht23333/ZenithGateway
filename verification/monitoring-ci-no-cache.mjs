// Proves the monitoring CI prerequisite against a separate, initially empty Docker daemon.
// Requires Linux-container Docker with privileged DinD support. No host Docker socket is mounted.
// node verification/monitoring-ci-no-cache.mjs [--out <new directory>]
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {randomUUID,createHash} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
const argument=process.argv.indexOf('--out')
const out=resolve(argument<0?'.dev/monitoring-ci-no-cache-'+randomUUID().slice(0,8):process.argv[argument+1])
await mkdir(out,{recursive:true})
await writeFile(join(out,'run-marker'),new Date().toISOString(),{flag:'wx'})
const root=resolve('.'),id=randomUUID().slice(0,8),name='zg-monitor-ci-'+id,network=name+'-net'
const dind='docker:29.8.0-dind@sha256:5efed980cba3fc126cf54e21a5a6ff8849d05b6e0623d6e7612f48e9cd6cd17e'
const workflow=await readFile(join(root,'.github/workflows/verify.yml'),'utf8')
const runner=await readFile(join(root,'observability/test-monitoring.mjs'),'utf8')
const image=runner.match(/const image='([^']+)'/)[1]
const prepare=workflow.match(/- name: Prepare pinned Prometheus test image\s+run: docker pull ([^\s]+)/)
assert(prepare,'CI must prepare the test image before executing the monitoring runner')
assert.equal(prepare[1],image,'CI and test runner must pin the same artifact')
assert(workflow.indexOf(prepare[0])<workflow.indexOf('run: node observability/test-monitoring.mjs'))
assert(runner.includes("'--pull=never'"),'The test itself remains an offline consumer')
const hash=text=>createHash('sha256').update(text).digest('hex')
const report={startedAt:new Date().toISOString(),image,dind,workflowSha256:hash(workflow),runnerSha256:hash(runner),checks:[],cleanup:{},passed:false}
const docker=(args,timeout=60000)=>{
 try{return {exitCode:0,output:execFileSync('docker',args,{encoding:'utf8',windowsHide:true,timeout,maxBuffer:8*1024*1024,stdio:['ignore','pipe','pipe']})}}
 catch(e){return {exitCode:e.status??-1,output:String(e.stdout||'')+String(e.stderr||'')+(e.message||'')}}
}
async function logged(file,args,timeout=60000,success=true){
 const r=docker(args,timeout);await writeFile(join(out,file),r.output)
 if(success)assert.equal(r.exitCode,0,file+': '+r.output.slice(-1800))
 return r
}
const snapshot=()=>Object.fromEntries([
 ['containers',['ps','-a','--format','{{.ID}} {{.Names}} {{.State}}']],
 ['networks',['network','ls','--format','{{.ID}} {{.Name}}']],
 ['volumes',['volume','ls','--format','{{.Name}}']],
 ['images',['image','ls','--no-trunc','--digests','--format','{{.Repository}} {{.Tag}} {{.Digest}} {{.ID}}']]
].map(([k,args])=>{const r=docker(args);assert.equal(r.exitCode,0);return [k,r.output.trim().split('\n').filter(Boolean).sort()]}))
const baseline=snapshot();await writeFile(join(out,'host-before.json'),JSON.stringify(baseline,null,2))
const existingHelper=docker(['image','inspect',dind]).exitCode===0
let started=false,networkCreated=false,pulled=false,failure
try{
 if(!existingHelper){await logged('bootstrap-dind.log',['pull',dind],300000);pulled=true}
 await logged('network-create.log',['network','create',network]);networkCreated=true
 await logged('daemon-create.log',['run','--rm','-d','--pull=never','--name',name,'--network',network,
  '--privileged','--cpus=2','--memory=1536m','--pids-limit=256','-e','DOCKER_TLS_CERTDIR=',
  '-v',root.replaceAll('\\','/')+':/workspace:ro','-v',out.replaceAll('\\','/')+':/evidence',
  dind,'dockerd','--host=unix:///var/run/docker.sock','--storage-driver=vfs','--iptables=false','--ip6tables=false','--bridge=none'])
 started=true
 const deadline=Date.now()+60000
 while(docker(['exec',name,'docker','info','--format','{{.ID}}'],5000).exitCode!==0){assert(Date.now()<deadline,'Isolated daemon startup timed out');await delay(250)}
 const mounts=await logged('daemon-mounts.json',['inspect',name,'--format','{{json .Mounts}}'])
 report.mounts=JSON.parse(mounts.output)
 assert(!report.mounts.some(m=>m.Source==='/var/run/docker.sock'),'Never share the host daemon')
 await logged('node-install.log',['exec',name,'apk','add','--no-cache','nodejs'],180000)
 report.nodeVersion=(await logged('node-version.txt',['exec',name,'node','--version'])).output.trim()
 await logged('daemon-info.json',['exec',name,'docker','info','--format','{{json .}}'])
 const before=await logged('cold-images.txt',['exec',name,'docker','image','ls','--quiet'])
 assert.equal(before.output.trim(),'','The isolated image store must be completely empty')
 const missing=await logged('cold-inspect.log',['exec',name,'docker','image','inspect',image],60000,false)
 assert.notEqual(missing.exitCode,0)
 const old=await logged('without-prepare.log',['exec','-w','/workspace',name,'node','observability/test-monitoring.mjs','--report','/evidence/without-prepare.json'],90000,false)
 assert.notEqual(old.exitCode,0)
 assert.match(old.output,/No such image|not found|does not exist/i)
 const rejected=JSON.parse(await readFile(join(out,'without-prepare.json'),'utf8'))
 assert.equal(rejected.passed,false);assert.equal(rejected.ruleCases,0)
 report.beforePreparation={imageCount:0,nodeExitCode:old.exitCode,passed:false,ruleCases:rejected.ruleCases}
 console.log('PASS empty image store reproduces failure before any rule assertions')
 await logged('prepare-image.log',['exec',name,'docker','pull',prepare[1]],300000)
 const artifact=await logged('prepared-image.json',['exec',name,'docker','image','inspect',image])
 report.preparedImage=JSON.parse(artifact.output).map(x=>({Id:x.Id,RepoDigests:x.RepoDigests}))
 assert(report.preparedImage.some(x=>x.RepoDigests.includes('prom/prometheus@'+image.split('@')[1])))
 await logged('with-prepare.log',['exec','-w','/workspace',name,'node','observability/test-monitoring.mjs','--report','/evidence/with-prepare.json'],90000)
 report.monitoring=JSON.parse(await readFile(join(out,'with-prepare.json'),'utf8'))
 assert.equal(report.monitoring.passed,true)
 assert.equal(report.monitoring.ruleAssertions+report.monitoring.dashboardAssertions,183)
 assert.equal((await logged('nested-containers.txt',['exec',name,'docker','ps','-a','--quiet'])).output.trim(),'')
 report.checks=['Initial daemon image store empty','Old entry fails with missing image before rule assertions',
  'CI pulls exact digest used by unchanged runner','All 183 rule/dashboard assertions pass with --pull=never','Nested test containers removed']
 console.log('PASS explicit pinned pull enables all 183 assertions in the fresh daemon')
}catch(e){failure=e;report.error=e.stack;process.exitCode=1;console.error(e)}
finally{
 if(started){
  await logged('daemon.log',['logs',name],60000,false)
  const removed=await logged('daemon-remove.log',['rm','-f','-v',name],60000,false)
  report.cleanup.daemonAndAnonymousVolumesRemoved=removed.exitCode===0
 }
 if(networkCreated)report.cleanup.networkRemoved=(await logged('network-remove.log',['network','rm',network],60000,false)).exitCode===0
 if(pulled)report.cleanup.newHelperImageRemoved=(await logged('helper-remove.log',['image','rm',dind],60000,false)).exitCode===0
 const after=snapshot();await writeFile(join(out,'host-after.json'),JSON.stringify(after,null,2))
 for(const key of ['containers','networks','volumes','images'])report.cleanup[key+'MatchBaseline']=JSON.stringify(after[key])===JSON.stringify(baseline[key])
 report.passed=!failure&&Object.values(report.cleanup).every(x=>x===true)
 if(!report.passed)process.exitCode=1
 report.finishedAt=new Date().toISOString();await writeFile(join(out,'validation.json'),JSON.stringify(report,null,2)+'\n')
 console.log('Cold-cache evidence: '+out)
}
