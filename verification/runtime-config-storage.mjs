// Offline storage-format recovery. Never run while any old/new gateway or management writer is active.
import {readFile,writeFile} from 'node:fs/promises'
import {randomUUID,createHash} from 'node:crypto'
import {redisCommand} from '../benchmarks/redis.mjs'
import {pathToFileURL} from 'node:url'
import {resolve} from 'node:path'

const fields=['rateLimitEnabled','replenishRate','burstCapacity','requestedTokens','monitorWindowSeconds','emitIntervalSeconds']
export function validateValues(config) {
 if(!config||typeof config.rateLimitEnabled!=='boolean')throw new Error('Invalid rateLimitEnabled')
 const ranges={replenishRate:10000,burstCapacity:10000,requestedTokens:100,monitorWindowSeconds:120,emitIntervalSeconds:5}
 for(const [key,max] of Object.entries(ranges))if(!Number.isInteger(config[key])||config[key]<1||config[key]>max)throw new Error('Invalid '+key)
 return Object.fromEntries(fields.map(k=>[k,config[k]]))
}
const sha=raw=>createHash('sha256').update(raw).digest('hex')
const replaceScript="local current=redis.call('GET',KEYS[1]); if (ARGV[3]=='missing' and current) or (ARGV[3]~='missing' and current~=ARGV[1]) then return 0 end; redis.call('SET',KEYS[1],ARGV[2]); return 1"
export async function runStorageTool(args,env=process.env) {
 const [mode,...flags]=args
 const flag=name=>{const i=flags.indexOf('--'+name);return i<0?undefined:flags[i+1]}
 const database=Number(flag('database')||0)
 const port=Number(flag('port')),key=flag('key'),file=flag('file')
 if(!['backup','downgrade','downgrade-v1','downgrade-v2','restore'].includes(mode)||!Number.isInteger(port)||port<1||port>65535||!Number.isInteger(database)||database<0||!key||!file)
  throw new Error('Usage: node verification/runtime-config-storage.mjs backup|downgrade|downgrade-v1|downgrade-v2|restore --port PORT --key KEY --file BACKUP.json [--host HOST] [--database DB] [--maintenance]')
 const command=cmd=>redisCommand(port,cmd,{host:flag('host')||'127.0.0.1',database,username:env.RUNTIME_REDIS_USER,password:env.RUNTIME_REDIS_PASSWORD})
 const raw=await command(['GET',key])
 if(raw===null&&mode!=='restore')throw new Error('Key is missing; refuse implicit initialization')
 if(mode==='backup'){
  const config=JSON.parse(raw);validateValues(config)
  const backup={key,database,createdAt:new Date().toISOString(),sha256:sha(raw),raw}
  // Refuse accidental destruction of an existing recovery point.
  await writeFile(file,JSON.stringify(backup,null,2)+'\n',{flag:'wx'})
  return {mode,key,sha256:backup.sha256,version:config.version??null,written:false}
 }
 if(!flags.includes('--maintenance'))throw new Error('Stop all gateways/writers first, then explicitly pass --maintenance')
 const backup=JSON.parse(await readFile(file,'utf8'))
 if(backup.key!==key||backup.database!==database||sha(backup.raw)!==backup.sha256)throw new Error('Backup key or SHA-256 mismatch')
 const config=JSON.parse(backup.raw),values=validateValues(config)
 let replacement
 // Receipt-bearing recovery can terminate already-promised receipt guarantees; require a separate acknowledgement.
 let currentSchema;try{currentSchema=JSON.parse(raw)?.schemaVersion}catch{}
 if(([2,3].includes(config.schemaVersion)||[2,3].includes(currentSchema)) && !flags.includes('--acknowledge-receipt-loss'))
  throw new Error('Versioned operation records contain receipts. Preserve the full backup and explicitly pass --acknowledge-receipt-loss; all writers must be stopped')
 if(mode==='downgrade'||mode==='downgrade-v1'||mode==='downgrade-v2'){
  if(raw!==backup.raw)throw new Error('Storage differs from backup; do not overwrite subsequent changes')
  if(![1,2,3].includes(config.schemaVersion)||typeof config.version!=='string')throw new Error('Expected versioned backup')
  replacement=JSON.stringify(mode==='downgrade'?values:{...values,schemaVersion:mode==='downgrade-v2'?2:1,version:randomUUID()+':1',...(mode==='downgrade-v2'?{operations:{},history:[]}: {})})
 }else{
  // A fresh generation prevents old browser versions from matching recovered values.
  replacement=JSON.stringify({...values,schemaVersion:[2,3].includes(config.schemaVersion)?3:1,version:randomUUID()+':1',...([2,3].includes(config.schemaVersion)?{operations:{},history:[]}: {})})
 }
 let result
 try{result=await command(['EVAL',replaceScript,1,key,raw??'',replacement,raw===null?'missing':'present'])}
 catch{throw new Error('Storage acknowledgement unavailable; replacement may have executed. Read storage before taking another action')}
 if(result!==1)throw new Error('Storage changed during maintenance; nothing written')
 return {mode,key,backupSha256:backup.sha256,written:true,version:JSON.parse(replacement).version??null}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 try{console.log(JSON.stringify(await runStorageTool(process.argv.slice(2)),null,2))}
 catch(error){console.error(error.message);process.exitCode=1}
}
