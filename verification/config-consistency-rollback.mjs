import {runStorageTool} from './runtime-config-storage.mjs'
import {redisCommand} from '../benchmarks/redis.mjs'
import {execFileSync} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import assert from 'node:assert/strict'
const name='zenith-config-rollback-'+randomUUID().slice(0,8),key='zg:test:rollback:'+randomUUID()
const out='.dev/config-consistency/rollback-'+randomUUID();await mkdir(out,{recursive:true})
const docker=args=>execFileSync('docker',args,{encoding:'utf8',windowsHide:true}).trim()
const report={passed:false,checks:[],cleanup:{}}
let created=false
try{
 docker(['run','--rm','-d','--pull=never','--name',name,'-p','127.0.0.1::6379','redis:7.4-alpine','--appendonly','no','--save','']);created=true
 const port=Number(docker(['port',name,'6379/tcp']).split(':').at(-1)),password=randomUUID()
 await redisCommand(port,['ACL','SETUSER','recovery','on','>'+password,'~'+key,'+get','+set','+eval'])
 const env={RUNTIME_REDIS_USER:'recovery',RUNTIME_REDIS_PASSWORD:password}
 const values={rateLimitEnabled:true,replenishRate:37,burstCapacity:40,requestedTokens:1,monitorWindowSeconds:30,emitIntervalSeconds:2}
 const config={...values,schemaVersion:1,version:randomUUID()+':5'},file=out+'/backup.json'
 await redisCommand(port,['SET',key,JSON.stringify(config)])
 const args=['--port',String(port),'--key',key,'--file',file]
 await runStorageTool(['backup',...args],env)
 await assert.rejects(()=>runStorageTool(['backup',...args],env),/EEXIST/)
 await assert.rejects(()=>runStorageTool(['downgrade',...args],env),/Stop all gateways/)
 const backup=JSON.parse(await readFile(file,'utf8'));assert.equal(backup.raw,JSON.stringify(config))
 report.checks.push('Authenticated backup preserves exact raw bytes and refuses overwriting an existing backup')
 const newer={...config,version:config.version.replace(':5',':6')}
 await redisCommand(port,['SET',key,JSON.stringify(newer)])
 await assert.rejects(()=>runStorageTool(['downgrade',...args,'--maintenance'],env),/differs from backup/)
 assert.equal(await redisCommand(port,['GET',key]),JSON.stringify(newer))
 report.checks.push('Downgrade refuses to overwrite values changed since the backup')
 await redisCommand(port,['SET',key,backup.raw])
 await runStorageTool(['downgrade',...args,'--maintenance'],env)
 assert.deepEqual(JSON.parse(await redisCommand(port,['GET',key])),values)
 report.checks.push('Offline downgrade leaves exactly the old six-field JSON')
 const restored=await runStorageTool(['restore',...args,'--maintenance'],env)
 const stored=JSON.parse(await redisCommand(port,['GET',key]))
 assert.equal(stored.schemaVersion,1);assert.notEqual(stored.version,config.version);assert.match(stored.version,/:1$/)
 assert.deepEqual(Object.fromEntries(Object.keys(values).map(k=>[k,stored[k]])),values)
 report.checks.push('Restore creates a new generation with the backed-up six values, invalidating stale clients')
 const bad=out+'/tampered.json';await writeFile(bad,JSON.stringify({...backup,raw:backup.raw+' '}))
 await assert.rejects(()=>runStorageTool(['restore','--port',String(port),'--key',key,'--file',bad,'--maintenance'],env),/SHA-256/)
 report.checks.push('Tampered backups cannot be restored')
 await redisCommand(port,['DEL',key])
 await runStorageTool(['restore',...args,'--maintenance'],env)
 const missingRecovered=JSON.parse(await redisCommand(port,['GET',key]))
 assert.notEqual(missingRecovered.version,stored.version);assert.equal(missingRecovered.monitorWindowSeconds,30)
 report.checks.push('Missing-key recovery uses an atomic absence check and starts a fresh generation')
 const boundaryKey=key+':format',lua=await readFile('backend/src/main/resources/runtime-config.lua','utf8')
 const maximumEpoch=randomUUID(),nearMax={...values,schemaVersion:3,operations:{},history:[],version:maximumEpoch+':9007199254740990'}
 await redisCommand(port,['SET',boundaryKey,JSON.stringify(nearMax)])
 const accepted=JSON.parse(await redisCommand(port,['EVAL',lua,1,boundaryKey,'write',nearMax.version,JSON.stringify(values),randomUUID(),randomUUID()]))
 assert.equal(accepted.status,'ok');assert.equal(accepted.snapshot.version,maximumEpoch+':9007199254740991')
 const exhausted=JSON.parse(await redisCommand(port,['EVAL',lua,1,boundaryKey,'write',accepted.snapshot.version,JSON.stringify(values),randomUUID(),randomUUID()]))
 assert.equal(exhausted.status,'exhausted')
 report.checks.push('Lua increments the last safe decimal revision exactly once and refuses overflow')
 await redisCommand(port,['DEL',boundaryKey]);await redisCommand(port,['HSET',boundaryKey,'preserve','evidence'])
 const wrongType=JSON.parse(await redisCommand(port,['EVAL',lua,1,boundaryKey,'init',randomUUID()+':1',JSON.stringify(values),randomUUID(),randomUUID()]))
 assert.equal(wrongType.status,'invalid');assert.equal(await redisCommand(port,['HGET',boundaryKey,'preserve']),'evidence')
 report.checks.push('A wrong Redis key type is rejected without deleting or replacing evidence')
 report.restored=restored;report.passed=true
}finally{
 if(created){docker(['stop','--timeout','5',name]);report.cleanup.redisRemoved=true}
 await writeFile(out+'/rollback-validation.json',JSON.stringify(report,null,2)+'\n')
}
console.log(JSON.stringify(report,null,2))
