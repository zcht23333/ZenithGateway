import {execFileSync} from 'node:child_process'
import {realpath,unlink} from 'node:fs/promises'
import {join} from 'node:path'
import {within} from './acceptance-core.mjs'
export const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:8*1024*1024}).trim()
export function hostResources() {
 return {containers:docker('ps','-a','--no-trunc','--format','{{.ID}} {{.Names}} {{.State}}').split('\n').filter(Boolean),
  networks:docker('network','ls','--no-trunc','--format','{{.ID}} {{.Name}}').split('\n').filter(Boolean),
  volumes:docker('volume','ls','-q').split('\n').filter(Boolean),images:docker('image','ls','--no-trunc','--format','{{.ID}}').split('\n').filter(Boolean)}
}
function ownedJava(id) {
 const marker='-Dzenith.verification.run='+id
 if(process.platform==='win32') {
  const script=`$found = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'java.exe' -and $_.CommandLine -like '*${marker}*' } | Select-Object ProcessId); ConvertTo-Json -InputObject $found -Compress`
  return JSON.parse(execFileSync('powershell',['-NoProfile','-Command',script],{encoding:'utf8',windowsHide:true,timeout:20000})||'[]').map(x=>x.ProcessId)
 }
 return execFileSync('ps',['-eo','pid=,args='],{encoding:'utf8',timeout:10000}).split('\n').filter(x=>x.includes(marker)&&/\bjava\b/.test(x)).map(x=>Number(x.trim().split(/\s+/)[0]))
}
export async function cleanupScope(id,{force=false}={}) {
 if(!/^zg-[a-f0-9-]{36}$/.test(id))throw new Error('Invalid cleanup scope')
 const filter='label=zenith.acceptance='+id
 const names=(kind)=>docker(...(kind==='container'?['ps','-a','-q','--filter',filter]:[kind,'ls','-q','--filter',filter])).split('\n').filter(Boolean)
 const before={containers:names('container'),networks:names('network'),volumes:names('volume'),java:ownedJava(id)}
 const errors=[]
 if(force) {
  for(const pid of before.java)try {
   if(process.platform==='win32')execFileSync('taskkill',['/PID',String(pid),'/T','/F'],{windowsHide:true,stdio:'pipe',timeout:10000})
   else process.kill(pid,'SIGKILL')
  }catch(e){errors.push('java '+pid+': '+e.message)}
  for(const pid of before.containers)try{docker('rm','-fv',pid)}catch(e){errors.push(e.message)}
  for(const n of before.networks)try{docker('network','rm',n)}catch(e){errors.push(e.message)}
  for(const n of before.volumes)try{docker('volume','rm',n)}catch(e){errors.push(e.message)}
 }
 const after={containers:names('container'),networks:names('network'),volumes:names('volume'),java:ownedJava(id)}
 return {before,after,forced:force&&Object.values(before).some(v=>v.length>0),errors,
  passed:errors.length===0&&Object.values(after).every(v=>v.length===0)}
}

// Only these short-lived private files are created by the selected live checks.
export async function cleanupCredentials(out) {
 const root=await realpath(out),removed=[]
 for(const path of ['checks/proxy-resilience/upstream.p12',
  'checks/lifecycle-functional/credentials/zenith.admin.token','checks/lifecycle-signal/credentials/zenith.admin.token']) {
  const candidate=join(root,path);let actual
  try{actual=await realpath(candidate)}catch(e){if(e.code==='ENOENT')continue;throw e}
  if(!within(root,actual))throw new Error('Refusing credential cleanup outside this output: '+path)
  await unlink(candidate);removed.push(path)
 }
 return {passed:true,removed}
}

// An anonymous Docker volume has no inherited container label. Observe the host delta as well;
// never delete an unlabelled resource merely because it appeared while a suite was running.
export function auditHostResources(before,after) {
 const delta=key=>({added:[...new Set(after[key])].filter(v=>!before[key].includes(v)),
  removed:[...new Set(before[key])].filter(v=>!after[key].includes(v))})
 const result={containers:delta('containers'),volumes:delta('volumes'),networks:delta('networks'),images:delta('images')}
 // Default bridge identity has changed in existing experiments; report it without claiming ownership.
 // Images are immutable shared download caches. Neither is automatically pruned here.
 result.passed=['containers','volumes'].every(k=>result[k].added.length===0&&result[k].removed.length===0)
 return result
}
