import assert from 'node:assert/strict'
import {spawn, execFileSync} from 'node:child_process'
import {createServer} from 'node:net'
import {createHash, randomBytes} from 'node:crypto'
import {mkdir, readFile, writeFile, unlink} from 'node:fs/promises'
import {resolve, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {setTimeout as delay} from 'node:timers/promises'
import {redisCommand} from './redis.mjs'

const root=resolve(fileURLToPath(new URL('..',import.meta.url)))
process.chdir(root)
const id=randomBytes(5).toString('hex'),project='zenith-cold-'+id,redisName=project+'-host-redis'
const out=resolve(process.env.BENCH_COLD_OUTPUT||'.dev/config-consistency-p2/cold-start-'+id)
const jar=resolve(process.env.BENCH_JAR||'backend/target/zg-1.0.0.jar')
const image='redis:7.4.11-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499'
const report={startedAt:new Date().toISOString(),isolated:true,project,checks:[],evidence:{},cleanup:{},passed:false}
await mkdir(out,{recursive:true})
const cleanEnv={...process.env}
for(const key of Object.keys(cleanEnv))if(/^(BENCH_|PROFILE_)/.test(key))delete cleanEnv[key]
const docker=args=>execFileSync('docker',args,{encoding:'utf8',windowsHide:true,timeout:30000}).trim()
const composeArgs=['compose','-f','benchmarks/profile.compose.yml','-f',join(out,'compose.override.json'),'-p',project]
const composeEnv={...cleanEnv,PROFILE_JAR:jar.replaceAll('\\','/'),PROFILE_GC:'G1',PROFILE_METRICS:'true'}
let hostRedis=false,profileStarted=false,redisPort,profileBase,secretCreated=false
async function freePort(){
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r))
 const port=server.address().port;await new Promise(r=>server.close(r));return port
}
async function run(command,args,label,env=cleanEnv,expected=0){
 const child=spawn(command,args,{cwd:root,env,windowsHide:true})
 let stdout='',stderr='',spawnError
 child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk)
 child.on('error',error=>spawnError=error)
 const timeout=setTimeout(()=>child.kill(),240000)
 const code=await new Promise(resolve=>child.on('close',resolve));clearTimeout(timeout)
 await writeFile(join(out,label+'.log'),stdout+'\n'+stderr)
 if(spawnError)throw spawnError
 assert.equal(code,expected,label+': '+(stderr||stdout).slice(-2000))
 return {code,stdout,stderr}
}
async function check(name,fn){await fn();report.checks.push(name);console.log('PASS '+name)}
function healthy(load){
 assert.ok(load.requests>0);assert.equal(load.transportErrors,0)
 assert.equal(load.statuses['200'],load.requests);assert.equal(load.statuses['429']||0,0)
}
function legal(current){
 assert.equal(current.rateLimitEnabled,true);assert.equal(current.replenishRate,10000)
 assert.equal(current.burstCapacity,10000);assert.equal(current.requestedTokens,1)
 assert.match(current.version,/:1$/)
}
try{
 const cpus=Number(docker(['info','--format','{{.NCPU}}']));assert.ok(cpus>=12,'Actual profile CPU sets require 12 Docker CPUs')
 report.environment={dockerCpus:cpus,node:process.version,redisImage:image,jarSha256:createHash('sha256').update(await readFile(jar)).digest('hex')}
 docker(['run','--rm','-d','--pull=never','--name',redisName,'-p','127.0.0.1::6379',image,'--save','','--appendonly','no']);hostRedis=true
 redisPort=Number(docker(['port',redisName,'6379/tcp']).split(':').at(-1))
 const command=args=>redisCommand(redisPort,args)
 for(let i=0;;i++){try{await command(['PING']);break}catch(error){if(i===50)throw error;await delay(100)}}
 await check('Illegal original 1000000 startup parameters still fail with an empty runtime key',async()=>{
  const key='zg:cold:invalid:'+id,port=await freePort()
  assert.equal(await command(['EXISTS',key]),0)
  const java=process.env.JAVA_HOME?join(process.env.JAVA_HOME,'bin',process.platform==='win32'?'java.exe':'java'):'java'
  const result=await run(java,['-jar',jar,'--server.address=127.0.0.1','--server.port='+port,
   '--spring.data.redis.host=127.0.0.1','--spring.data.redis.port='+redisPort,'--spring.data.redis.password=',
   '--zenith.runtime.redis-key='+key,'--zenith.route.redis-key=zg:cold:invalid-routes:'+id,'--zenith.audit.enabled=false',
   '--zenith.rate-limit.replenish-rate=1000000','--zenith.rate-limit.burst-capacity=1000000'],
   'invalid-startup',{...cleanEnv,ZENITH_ADMIN_TOKEN:randomBytes(24).toString('hex')},1)
  assert.equal(await command(['EXISTS',key]),0)
  assert.match(result.stdout+result.stderr,/invalid|无效|非法/i)
  report.evidence.illegalStartup={exitCode:result.code,missingBeforeStart:true,missingAfterExit:true,rate:1000000,capacity:1000000}
 })
 await check('The real benchmark runner cold-starts at 10000 and completes normal warmup and measurement without 429',async()=>{
  const result=await run(process.execPath,['benchmarks/run.mjs'],'benchmark-run',{
   ...cleanEnv,BENCH_JAR:jar,BENCH_REDIS_PORT:String(redisPort),BENCH_GATEWAY_PORT:String(await freePort()),
   BENCH_SCENARIOS:'rate-limit-audit',BENCH_REPETITIONS:'1'})
  const match=result.stdout.match(/Report: (.+)/);assert.ok(match,'runner report path')
  const source=match[1].trim(),data=JSON.parse(await readFile(source,'utf8'))
  assert.equal(data.workload.warmupSeconds,15);assert.equal(data.workload.durationSeconds,30)
  assert.equal(data.workload.connections,16);assert.equal(data.workload.closedLoop,true)
  const sample=data.scenarios[0];assert.equal(sample.coldStart.missingBeforeStart,true);legal(sample.coldStart.confirmed)
  const stored=JSON.parse(await command(['GET',sample.coldStart.runtimeKey]));legal(stored)
  assert.equal(stored.version,sample.coldStart.confirmed.version)
  healthy(sample.warmup);healthy(sample)
  assert.equal(sample.reconciliationGap,0);assert.equal(sample.monitorGap,0);assert.equal(sample.auditGap,0)
  assert.equal(sample.audit.dropped+sample.audit.uncertain,0)
  report.evidence.benchmark={source,workload:data.workload,confirmed:sample.coldStart.confirmed,
   runtimeKey:sample.coldStart.runtimeKey,missingBeforeStart:true,warmup:sample.warmup,
   requests:sample.requests,statuses:sample.statuses,transportErrors:sample.transportErrors,
   requestsPerSecond:sample.requestsPerSecond,audit:sample.audit,redisCommands:sample.redisCommands}
 })
 await check('A fixed arrival above the enabled limiter maximum is rejected before launching the gateway',async()=>{
  const result=await run(process.execPath,['benchmarks/run.mjs'],'offered-load-rejected',{
   ...cleanEnv,BENCH_JAR:jar,BENCH_ARRIVAL_RATE:'10001',BENCH_SCENARIOS:'rate-limit'},1)
  assert.match(result.stderr,/exceeds the enabled limiter rate/)
 })
 docker(['stop','--timeout','5',redisName]);hostRedis=false;report.cleanup.hostRedisRemoved=true
 const token=randomBytes(24).toString('hex'),secretFile=join(out,'admin-token')
 await writeFile(secretFile,token,{flag:'wx'});secretCreated=true
 await writeFile(join(out,'compose.override.json'),JSON.stringify({
  services:{gateway:{ports:['127.0.0.1::8080']}},
  secrets:{'gateway-admin':{file:secretFile.replaceAll('\\','/')}}
 },null,2))
 const compose=(args,label,env=composeEnv)=>run('docker',[...composeArgs,...args],label,env)
 profileStarted=true
 await compose(['up','-d','--pull','never','redis','upstream'],'profile-dependencies')
 await check('The actual profile Compose gateway cold-starts from a missing configuration key',async()=>{
  const missing=docker([...composeArgs,'exec','-T','redis','redis-cli','EXISTS','zg:profile:runtime'])
  assert.equal(missing,'0')
  await compose(['up','-d','--pull','never','gateway'],'profile-gateway')
  const binding=docker([...composeArgs,'port','gateway','8080']);profileBase='http://'+binding
  const deadline=Date.now()+60000;let current
  while(Date.now()<deadline){
   try{
    const response=await fetch(profileBase+'/settings/runtime',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(2000)})
    if(response.ok){current=await response.json();break}
   }catch{}
   await delay(200)
  }
  assert.ok(current,'profile startup readiness');legal(current)
  const health=await fetch(profileBase+'/actuator/health/readiness');assert.equal(health.status,200)
  const stored=JSON.parse(docker([...composeArgs,'exec','-T','redis','redis-cli','GET','zg:profile:runtime']));legal(stored)
  assert.equal(stored.version,current.version)
  report.evidence.profile={missingBeforeStart:true,confirmed:current,stored}
 })
 for(const [phase,seconds] of [['warmup',45],['measure',60]])await check('Actual profile driver '+phase+' completes without 429 or lost accounting',async()=>{
  const result=await compose(['run','--rm','--no-deps','driver'],'profile-'+phase,{
   ...composeEnv,PROFILE_PHASE:phase,PROFILE_SECONDS:String(seconds)})
  const data=JSON.parse(result.stdout.trim());healthy(data)
  assert.equal(data.audit.received,data.requests);assert.equal(data.audit.persisted,data.requests)
  assert.equal(data.audit.dropped+data.audit.uncertain,0);assert.equal(data.finalPending,0)
  report.evidence.profile[phase]={seconds,connections:16,...data}
 })
 report.passed=true
}catch(error){report.failure=error.stack;process.exitCode=1}
finally{
 if(hostRedis){docker(['stop','--timeout','5',redisName]);report.cleanup.hostRedisRemoved=true}
 if(profileStarted){
  try{await run('docker',[...composeArgs,'logs','--no-color','gateway'],'profile-gateway-log',composeEnv)}
  finally{await run('docker',[...composeArgs,'down','--volumes','--remove-orphans'],'profile-cleanup',composeEnv);report.cleanup.profileRemoved=true}
 }
 if(secretCreated){await unlink(join(out,'admin-token'));report.cleanup.secretRemoved=true}
 report.completedAt=new Date().toISOString()
 await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n')
 console.log('Cold startup report: '+join(out,'report.json'))
 if(!report.passed)console.error(report.failure)
}
