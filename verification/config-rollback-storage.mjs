// Real Redis 7.4, bounded records and deliberate storage fault boundaries. Owns all data and its container.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {redisCommand} from '../benchmarks/redis.mjs'
import {runtimeValues,runtimeRequest} from './runtime-config-client.mjs'
import {runStorageTool} from './runtime-config-storage.mjs'
const id=randomUUID().slice(0,8),name='zenith-rollback-storage-'+id,key='zg:rollback:'+id
const out='.dev/config-rollback/storage-'+id;await mkdir(out,{recursive:true})
const report={passed:false,checks:[],evidence:{},cleanup:{}}
const docker=args=>execFileSync('docker',args,{encoding:'utf8',windowsHide:true,timeout:30000}).trim()
const script=await readFile('backend/src/main/resources/runtime-config.lua','utf8')
const old=await readFile('backend/src/test/resources/compatibility/runtime-schema2.lua','utf8')
const initial={rateLimitEnabled:false,replenishRate:20,burstCapacity:40,requestedTokens:1,monitorWindowSeconds:10,emitIntervalSeconds:1}
let created=false,port
const redis=args=>redisCommand(port,args)
const call=async(mode,expected='',candidate={},operationId=randomUUID(),target=key,lua=script,options={})=>
 JSON.parse(await redisCommand(port,['EVAL',lua,1,target,mode,expected,typeof candidate==='string'?candidate:JSON.stringify(candidate),operationId,randomUUID()],options))
const init=async(target=key,lua=script)=>call('init',randomUUID()+':1',initial,randomUUID(),target,lua)
const raw=()=>redis(['GET',key]),doc=async()=>JSON.parse(await raw())
const ref=r=>({version:r.after.version,operationId:r.operationId})
const write=async(current,patch={})=>call('write',current.version,{...runtimeValues(current),...patch})
const preview=source=>call('rollback-preview','',source)
const operation=id=>call('operation','','{}',id)
const check=async(name,fn)=>{await fn();report.checks.push(name);console.log('PASS '+name)}
try {
 docker(['run','--rm','-d','--pull=never','--name',name,'-p','127.0.0.1::6379',
  'redis:7.4.11-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499','--save','','--appendonly','no']);created=true
 port=Number(docker(['port',name,'6379/tcp']).split(':').at(-1));assert.equal(await redis(['PING']),'PONG')
 let current,source,duplicateSource,recovery,request
 await check('Schema-2 migration preserves all receipt identities, values, versions, timestamps and replay binding',async()=>{
  current=(await init(key,old)).snapshot
  const prior=await call('write',current.version,{...initial,replenishRate:33},randomUUID(),key,old)
  const before=await doc(),beforeRaw=await raw()
  assert.equal((await call('read')).status,'invalid');assert.equal(await raw(),beforeRaw)
  const starts=await Promise.all(Array.from({length:6},()=>init()))
  assert.ok(starts.every(r=>r.status==='ok' && r.snapshot.version===prior.snapshot.version))
  const after=await doc();assert.equal(after.schemaVersion,3)
  const original=prior.receipt,typed=after.operations[original.operationId]
  assert.deepEqual(typed,{...original,operationType:'update'});assert.deepEqual(after.history[0],typed)
  for(const mode of ['read','write','init'])assert.equal((await call(mode,current.version,initial,randomUUID(),key,old)).status,'invalid')
  const replay=await call('write',original.expectedVersion,original.request,original.operationId)
  assert.equal(replay.replayed,true);assert.deepEqual(replay.receipt,typed)
  current=replay.snapshot;source=typed;report.evidence.migration={before,after}
 })
 await check('Preview uses authoritative six fields; rollback generates a higher version with full source provenance, including equal values',async()=>{
  duplicateSource=(await write(current)).receipt;current=duplicateSource.after
  const p=await preview(ref(source));assert.equal(p.noChanges,true);assert.deepEqual(p.target,source.after)
  current=(await write(current,{rateLimitEnabled:true,replenishRate:3,burstCapacity:7,requestedTokens:2,monitorWindowSeconds:30,emitIntervalSeconds:3})).snapshot
  const view=await preview(ref(source));assert.equal(view.noChanges,false);assert.deepEqual(view.current,current)
  request={expectedVersion:current.version,operationId:randomUUID(),source:ref(source)}
  recovery=await call('rollback',request.expectedVersion,request.source,request.operationId)
  assert.equal(recovery.status,'ok');assert.equal(recovery.receipt.operationType,'rollback')
  assert.deepEqual(runtimeValues(recovery.snapshot),runtimeValues(source.after))
  assert.deepEqual(recovery.receipt.before,current);assert.deepEqual(recovery.receipt.source,{...ref(source),recordedAt:source.recordedAt})
  assert.equal(Number(recovery.snapshot.version.slice(37)),Number(current.version.slice(37))+1)
  assert.deepEqual((await doc()).history[0],recovery.receipt);current=recovery.snapshot
  const noChange=await call('rollback',current.version,ref(source));assert.equal(noChange.status,'ok')
  assert.equal(Number(noChange.snapshot.version.slice(37)),Number(current.version.slice(37))+1);current=noChange.snapshot
  report.evidence.normal={view,request,recovery,noChange}
 })
 await check('Concurrent identical recovery runs once; changed source, type or expectedVersion cannot reuse its identity',async()=>{
  const body={operationId:randomUUID(),expectedVersion:current.version,source:ref(source)}
  let release;const gate=new Promise(r=>release=r)
  const calls=Array.from({length:8},()=>gate.then(()=>call('rollback',body.expectedVersion,body.source,body.operationId)))
  release();const responses=await Promise.all(calls)
  assert.ok(responses.every(r=>r.status==='ok'));assert.equal(responses.filter(r=>!r.replayed).length,1)
  for(const response of responses)assert.deepEqual(response.receipt,responses[0].receipt)
  current=responses[0].snapshot;const before=await raw()
  for(const [mode,expected,candidate] of [['rollback',body.expectedVersion,ref(duplicateSource)],['rollback',current.version,body.source],['write',body.expectedVersion,runtimeValues(source.after)]]) {
   assert.equal((await call(mode,expected,candidate,body.operationId)).status,'operation-mismatch');assert.equal(await raw(),before)
  }
  assert.equal((await doc()).history.filter(r=>r.operationId===body.operationId).length,1)
  report.evidence.concurrent={body,responses}
 })
 await check('Concurrent normal update and rollback on one expectedVersion cannot both commit',async()=>{
  let release;const gate=new Promise(r=>release=r),expected=current.version
  const calls=[gate.then(()=>write(current,{replenishRate:44})),gate.then(()=>call('rollback',expected,ref(source)))]
  release();const responses=await Promise.all(calls)
  assert.deepEqual(responses.map(r=>r.status).sort(),['conflict','ok'])
  const rejected=responses.find(r=>r.status==='conflict');assert.equal(rejected.receipt.status,'rejected')
  assert.equal((await operation(rejected.receipt.operationId)).status,'rejected')
  current=responses.find(r=>r.status==='ok').snapshot
  report.evidence.conflict={expected,responses}
 })
 await check('Preview is not a reservation: expired or cropped source rejects a new recovery without any storage mutation',async()=>{
  await preview(ref(source));const before=await doc(),expired=structuredClone(before)
  const time=await redis(['TIME']),now=Number(time[0])*1000+Math.floor(Number(time[1])/1000)
  for(const r of [...Object.values(expired.operations),...expired.history])if(r.operationId===source.operationId){r.recordedAt=now-604800001;r.expiresAt=r.recordedAt+86400000}
  await redis(['SET',key,JSON.stringify(expired)]);let immutable=await raw()
  assert.equal((await preview(ref(source))).status,'history-unavailable')
  const rejected=await call('rollback',current.version,ref(source));assert.equal(rejected.status,'history-unavailable');assert.equal(await raw(),immutable)
  const cropped=structuredClone(before);cropped.history=cropped.history.filter(r=>r.operationId!==source.operationId)
  await redis(['SET',key,JSON.stringify(cropped)]);immutable=await raw()
  assert.equal((await call('rollback',current.version,ref(source))).status,'history-unavailable');assert.equal(await raw(),immutable)
  // Its operations receipt still exists, but operations is not the retained-history authority for NEW recoveries.
  assert.equal((await operation(source.operationId)).status,'committed')
  report.evidence.expiredOrCropped={expired:rejected,croppedRejected:true,sourceReceiptStillAvailable:true}
  await redis(['SET',key,JSON.stringify(before)])
 })
 await check('Successful rollback remains replayable and queryable after its source is cropped and later versions exist',async()=>{
  const before=await doc();before.history=before.history.filter(r=>r.operationId!==source.operationId)
  await redis(['SET',key,JSON.stringify(before)])
  current=(await write(current,{replenishRate:88})).snapshot;const unchanged=await raw()
  const queried=await operation(request.operationId),retry=await call('rollback',request.expectedVersion,request.source,request.operationId)
  assert.deepEqual(queried.receipt,recovery.receipt);assert.deepEqual(retry.receipt,recovery.receipt);assert.equal(retry.replayed,true)
  assert.equal(await raw(),unchanged);assert.equal((await doc()).version,current.version)
  report.evidence.croppedReplay={queried,retry,currentVersion:current.version}
 })
 await check('An unconfirmed operation stays unknown; expired receipts do not infer non-execution',async()=>{
  assert.equal((await operation(randomUUID())).status,'unknown')
  const before=await doc(),expired=structuredClone(before),r=expired.operations[request.operationId]
  // Expire the recovery, preserving source.recordedAt <= recordedAt and the complete historical facts.
  const time=await redis(['TIME']),now=Number(time[0])*1000+Math.floor(Number(time[1])/1000),shift=86401000
  for(const record of [...Object.values(expired.operations),...expired.history]) {
   record.recordedAt-=shift;record.expiresAt-=shift;if(record.source)record.source.recordedAt-=shift
  }
  assert.ok(r.expiresAt<now);await redis(['SET',key,JSON.stringify(expired)])
  assert.equal((await operation(request.operationId)).status,'unknown')
  assert.equal((await call('rollback',request.expectedVersion,request.source,request.operationId)).status,'history-unavailable')
  await redis(['SET',key,JSON.stringify(before)])
 })
 await check('Failure at the sole write command or immediately before it leaves config, receipt and history together unchanged',async()=>{
  const target=ref(duplicateSource),body={operationId:randomUUID(),expectedVersion:current.version,source:target},before=await raw()
  await redis(['ACL','SETUSER','rollback-no-set','on','>isolated-password','~'+key,'+get','+time','+eval'])
  const denied=await call('rollback',body.expectedVersion,body.source,body.operationId,key,script,{username:'rollback-no-set',password:'isolated-password'})
  assert.equal(denied.status,'rejected');assert.equal(await raw(),before)
  const injected=script.replace("local written = redis.pcall('SET', KEYS[1], encoded)","error('rollback injected before sole SET')\n    local written = redis.pcall('SET', KEYS[1], encoded)")
  await assert.rejects(()=>call('rollback',body.expectedVersion,body.source,body.operationId,key,injected),/rollback injected/)
  assert.equal(await raw(),before);assert.equal((await operation(body.operationId)).status,'unknown')
  await redis(['ACL','DELUSER','rollback-no-set'])
 })
 await check('512 active receipts cannot be evicted to admit rollback; same-source replay remains available at capacity',async()=>{
  const full=key+':capacity';let c=(await init(full)).snapshot
  const first=await call('write',c.version,runtimeValues(c),randomUUID(),full);c=first.snapshot
  const saved=await call('rollback',c.version,ref(first.receipt),randomUUID(),full);c=saved.snapshot
  for(let n=2;n<512;n++)c=(await call('write',c.version,runtimeValues(c),randomUUID(),full)).snapshot
  const rawFull=await redis(['GET',full]),value=JSON.parse(rawFull),latest=value.history[0]
  assert.equal(value.history.length,100);assert.equal(Object.keys(value.operations).length,512)
  const refused=await call('rollback',c.version,ref(latest),randomUUID(),full)
  assert.equal(refused.status,'receipt-capacity');assert.equal(await redis(['GET',full]),rawFull)
  const replay=await call('rollback',saved.receipt.expectedVersion,ref(first.receipt),saved.receipt.operationId,full)
  assert.equal(replay.replayed,true);assert.deepEqual(replay.receipt,saved.receipt)
  assert.equal(await redis(['GET',full]),rawFull)
  report.evidence.capacity={active:512,history:100,result:refused,replaySourceNoLongerInHistory:true};await redis(['DEL',full])
 })
 await check('Full backup and explicit schema-2 format downgrade preserve values but honestly terminate receipt guarantees',async()=>{
  const file=out+'/before-downgrade.json',args=['--port',String(port),'--key',key,'--file',file],before=await raw()
  await runStorageTool(['backup',...args])
  await assert.rejects(()=>runStorageTool(['downgrade-v2',...args,'--maintenance']),/acknowledge-receipt-loss/)
  assert.equal(await raw(),before)
  const downgraded=await runStorageTool(['downgrade-v2',...args,'--maintenance','--acknowledge-receipt-loss'])
  const oldRead=await call('read','','{}',randomUUID(),key,old);assert.equal(oldRead.status,'ok')
  assert.deepEqual(runtimeValues(oldRead.snapshot),runtimeValues(current));assert.notEqual(oldRead.snapshot.version,current.version)
  const remigrated=await init();assert.equal(remigrated.snapshot.version,oldRead.snapshot.version)
  assert.equal((await operation(request.operationId)).status,'unknown')
  const restored=await runStorageTool(['restore',...args,'--maintenance','--acknowledge-receipt-loss'])
  assert.equal((await doc()).schemaVersion,3);assert.equal((await call('read')).snapshot.version,restored.version)
  report.evidence.formatDowngrade={downgraded,restored}
 })
 report.passed=true
} catch(error) {report.failure=error.stack;process.exitCode=1;console.error(error.stack)}
finally {
 if(created){docker(['stop','--timeout','5',name]);report.cleanup.redisRemoved=true}
 await writeFile(out+'/report.json',JSON.stringify(report,null,2)+'\n');console.log('Storage report: '+out+'/report.json')
}
