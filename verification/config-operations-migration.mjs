// Offline protocol compatibility and receipt-loss acknowledgement; owns one Redis container.
import {runStorageTool} from './runtime-config-storage.mjs'
import {redisCommand} from '../benchmarks/redis.mjs'
import {runtimeRequest,runtimeValues} from './runtime-config-client.mjs'
import {execFileSync} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import assert from 'node:assert/strict'
const id=randomUUID().slice(0,8),name='zenith-operation-migration-'+id,key='zg:op-migration:'+id
const out='.dev/config-operations/migration-'+id;await mkdir(out,{recursive:true})
const docker=args=>execFileSync('docker',args,{encoding:'utf8',windowsHide:true,timeout:30000}).trim()
const report={passed:false,checks:[],cleanup:{}}
let created=false
try{
 docker(['run','--rm','-d','--pull=never','--name',name,'-p','127.0.0.1::6379',
 'redis:7.4.11-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499','--save','','--appendonly','no']);created=true
 const port=Number(docker(['port',name,'6379/tcp']).split(':').at(-1)),redis=args=>redisCommand(port,args)
 const oldScript=await readFile('backend/src/test/resources/compatibility/runtime-schema1.lua','utf8')
 const script=await readFile('backend/src/main/resources/runtime-config.lua','utf8')
 const initial={rateLimitEnabled:true,replenishRate:20,burstCapacity:40,requestedTokens:1,monitorWindowSeconds:10,emitIntervalSeconds:1}
 const run=(lua,mode,expected='',body=initial,id=randomUUID())=>redis(['EVAL',lua,1,key,mode,expected,JSON.stringify(runtimeValues(body)),id,randomUUID()]).then(JSON.parse)
 // Both formats are upgraded at init only. Concurrent starters preserve a single authority.
 for(const legacy of [{...initial},{...initial,schemaVersion:1,version:randomUUID()+':8'}]){
  await redis(['SET',key,JSON.stringify(legacy)])
  const runningRead=await run(script,'read');assert.equal(runningRead.status,'invalid')
  const results=await Promise.all(Array.from({length:8},()=>run(script,'init',randomUUID()+':1')))
  assert.ok(results.every(r=>r.status==='ok'));assert.equal(new Set(results.map(r=>r.snapshot.version)).size,1)
  if(legacy.version)assert.equal(results[0].snapshot.version,legacy.version)
  assert.deepEqual(runtimeValues(results[0].snapshot),initial)
 }
 report.checks.push('Legacy six-field and schema-1 concurrent init preserve one version and six values; running reads never migrate')
 const c=(await run(script,'read')).snapshot,body=runtimeRequest(c),committed=await run(script,'write',c.version,body,body.operationId)
 assert.equal(committed.status,'ok')
 const raw=await redis(['GET',key])
 for(const mode of ['read','write','init'])assert.equal((await run(oldScript,mode,c.version)).status,'invalid')
 assert.equal(await redis(['GET',key]),raw)
 report.checks.push('Actual previous Lua script refuses schema 3 in read/write/init without overwriting receipts')
 const file=out+'/full-backup.json',args=['--port',String(port),'--key',key,'--file',file]
 await runStorageTool(['backup',...args])
 assert.equal(JSON.parse(await readFile(file,'utf8')).raw,raw)
 for(const mode of ['downgrade','downgrade-v1','restore']){
  await assert.rejects(()=>runStorageTool([mode,...args,'--maintenance']),/acknowledge-receipt-loss/)
  assert.equal(await redis(['GET',key]),raw)
 }
 report.checks.push('Backup retains exact receipts; all schema-3 rollback/recovery paths require explicit receipt-loss acknowledgement')
 const downgraded=await runStorageTool(['downgrade-v1',...args,'--maintenance','--acknowledge-receipt-loss'])
 const oldRead=await run(oldScript,'read')
 assert.equal(oldRead.status,'ok');assert.notEqual(oldRead.snapshot.version,committed.snapshot.version)
 assert.deepEqual(runtimeValues(oldRead.snapshot),runtimeValues(committed.snapshot))
 assert.equal((await run(script,'read')).status,'invalid')
 const remigrated=await run(script,'init',randomUUID()+':1')
 assert.equal(remigrated.snapshot.version,oldRead.snapshot.version)
 assert.equal((await run(script,'operation','','{}',body.operationId)).status,'unknown')
 report.checks.push('Explicit format rollback produces a fresh schema-1 epoch; forward migration has no invented old receipts')
 const recovered=await runStorageTool(['restore',...args,'--maintenance','--acknowledge-receipt-loss'])
 assert.equal((await run(script,'read')).snapshot.version,recovered.version)
 assert.equal((await run(script,'operation','','{}',body.operationId)).status,'unknown')
 report.checks.push('Disaster recovery from schema-3 backup creates a new epoch and accurately loses old receipt availability')
 report.evidence={originalReceipt:committed.receipt,downgraded,recovered};report.passed=true
}catch(error){report.failure=error.stack;process.exitCode=1}
finally{
 if(created){docker(['stop','--timeout','5',name]);report.cleanup.redisRemoved=true}
 await writeFile(out+'/report.json',JSON.stringify(report,null,2)+'\n')
 console.log('Migration report: '+out+'/report.json');if(!report.passed)console.error(report.failure)
}
