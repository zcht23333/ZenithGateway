// Offline maintenance only. This tool never edits runtime configuration or operation receipts.
import {open} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {isIP} from 'node:net'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {redisCommand} from '../benchmarks/redis.mjs'
import {validateValues} from './runtime-config-storage.mjs'
const lua=`
if redis.call('GET',KEYS[1])~=ARGV[1] then return redis.error_reply('Runtime changed during maintenance') end
local p=cjson.decode(ARGV[2]);local fence=redis.call('GET',KEYS[2])
if fence and cjson.decode(fence).version~=p.version and ARGV[3]~='adopt-epoch' then return redis.error_reply('Policy fence differs; explicit epoch adoption required') end
local time=redis.call('TIME');local now=tonumber(time[1])*1000+math.floor(tonumber(time[2])/1000)
local tokens,billed
if ARGV[3]=='migrate-v1' then
 if redis.call('EXISTS',KEYS[4])~=0 then return redis.error_reply('Destination exists; refusing overwrite') end
 if redis.call('HGET',KEYS[3],'tokens')~=ARGV[4] or redis.call('HGET',KEYS[3],'ts')~=ARGV[5] then return redis.error_reply('Legacy source changed') end
 tokens=math.min(p.capacity*1000,math.floor(tonumber(ARGV[4])*1000));billed=now
else
 if redis.call('GET',KEYS[3])~=ARGV[4] then return redis.error_reply('Bucket changed') end
 local old=cjson.decode(ARGV[4]);tokens=math.min(p.capacity*1000,old.tokensMilli);billed=math.max(now,old.billedTimeMs)
end
local body=cjson.encode({schema=2,policy=p,tokensMilli=tokens,billedTimeMs=billed})
redis.call('SET',KEYS[2],ARGV[2])
redis.call('SET',KEYS[4],body,'PXAT',string.format('%.0f',billed+10001000))
return body`
export async function migrateLimiter({port,namespace,runtimeKey,backup,mode,maintenance=false,legacyPrefix='zg:rl:tb:',host='127.0.0.1',database=0},env=process.env){
 if(!maintenance)throw new Error('Stop all old/new gateways and writers, then explicitly pass --maintenance')
 if(!['migrate-v1','adopt-epoch'].includes(mode)||!Number.isInteger(port)||port<1||port>65535||!namespace?.match(/^[a-zA-Z0-9:_-]{1,128}$/)||!runtimeKey||!backup||!Number.isInteger(database)||database<0)throw new Error('Invalid limiter maintenance arguments')
 const command=a=>redisCommand(port,a,{host,database,username:env.RUNTIME_REDIS_USER,password:env.RUNTIME_REDIS_PASSWORD})
 const raw=await command(['GET',runtimeKey]);if(raw===null)throw new Error('Runtime config is missing')
 const config=JSON.parse(raw);validateValues(config)
 if(!config.version?.match(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}:[1-9][0-9]*$/)||!Number.isSafeInteger(Number(config.version.slice(37))))throw new Error('Expected a valid authoritative version')
 const policy={schema:2,version:config.version,capacity:config.burstCapacity,rate:config.replenishRate,cost:config.requestedTokens}
 const policyKey=namespace+':policy',prefix=mode==='migrate-v1'?legacyPrefix:namespace+':bucket:'
 if(!prefix||/[?*\[\]\\]/.test(prefix))throw new Error('Unsafe key prefix')
 const file=await open(backup,'wx');let count=0,cursor='0'
 try{
  await file.write(JSON.stringify({kind:'header',mode,namespace,runtimeKey,runtimeSha256:createHash('sha256').update(raw).digest('hex'),version:config.version,oldFence:await command(['GET',policyKey]),createdAt:new Date().toISOString()})+'\n')
  do{
   const batch=await command(['SCAN',cursor,'MATCH',prefix+'*','COUNT',128]);cursor=batch[0]
   for(const source of batch[1]){
    const ip=source.slice(prefix.length);if(!isIP(ip)&&ip!=='unknown')throw new Error('Unexpected bucket identity: '+source)
    const destination=namespace+':bucket:'+ip;let sourceRaw,ts=''
    if(mode==='migrate-v1'){
     const values=await command(['HMGET',source,'tokens','ts']);if(values[0]===null)continue
     if(!Number.isFinite(Number(values[0]))||Number(values[0])<0||!Number.isFinite(Number(values[1])))throw new Error('Invalid legacy balance')
     ;[sourceRaw,ts]=values
    }else{
     sourceRaw=await command(['GET',source]);if(sourceRaw===null)continue
     const bucket=JSON.parse(sourceRaw)
     if(bucket.schema!==2||!bucket.policy||!Number.isInteger(bucket.tokensMilli)||bucket.tokensMilli<0||bucket.tokensMilli>bucket.policy.capacity*1000||!Number.isSafeInteger(bucket.billedTimeMs)||bucket.billedTimeMs<0)throw new Error('Invalid versioned bucket')
    }
    await file.write(JSON.stringify({kind:'before',source,destination,sourceRaw,legacyTimestamp:ts,ttlMs:await command(['PTTL',source])})+'\n');await file.sync()
    const result=await command(['EVAL',lua,4,runtimeKey,policyKey,source,destination,raw,JSON.stringify(policy),mode,sourceRaw,ts])
    await file.write(JSON.stringify({kind:'after',destination,value:JSON.parse(result)})+'\n');count++
   }
  }while(cursor!=='0')
  // Empty deployments also establish the authoritative generation fence, guarded by the runtime bytes.
  const finish="if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end;local p=redis.call('GET',KEYS[2]);if p and cjson.decode(p).version~=ARGV[3] and ARGV[4]~='adopt-epoch' then return 0 end;redis.call('SET',KEYS[2],ARGV[2]);return 1"
  if(await command(['EVAL',finish,2,runtimeKey,policyKey,raw,JSON.stringify(policy),config.version,mode])!==1)throw new Error('Policy changed; keep maintenance enabled')
  await file.write(JSON.stringify({kind:'complete',count})+'\n');await file.sync();return {mode,count,version:config.version,backup,legacyKeysPreserved:mode==='migrate-v1'}
 }finally{await file.close()}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 const [mode,...args]=process.argv.slice(2),flag=name=>{const i=args.indexOf('--'+name);return i<0?undefined:args[i+1]}
 try{console.log(JSON.stringify(await migrateLimiter({mode,port:Number(flag('port')),namespace:flag('namespace'),runtimeKey:flag('runtime-key'),backup:flag('backup'),maintenance:args.includes('--maintenance'),legacyPrefix:flag('legacy-prefix')||'zg:rl:tb:',host:flag('host')||'127.0.0.1',database:Number(flag('database')||0)}),null,2))}
 catch(error){console.error(error.message+'; retain the backup and maintenance mode; a lost reply may have written the destination');process.exitCode=1}
}
