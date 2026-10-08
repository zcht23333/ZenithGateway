import {createHash} from 'node:crypto'
import {createWriteStream} from 'node:fs'
import {readFile,writeFile,readdir,lstat,mkdir,copyFile,chmod} from 'node:fs/promises'
import {spawn,execFileSync} from 'node:child_process'
import {join,resolve,relative,dirname,sep} from 'node:path'
export const sha = data => createHash('sha256').update(data).digest('hex')
export const fileHash = async path => sha(await readFile(path))
export async function json(path,value) { await mkdir(dirname(path),{recursive:true});await writeFile(path,JSON.stringify(value,null,2)+'\n') }
const excluded=new Set(['node_modules','target','dist','.dev','.git','results','logs'])
export async function treeFiles(root, prefix='') {
 const rows=[]
 for (const name of (await readdir(join(root,prefix))).sort()) {
  if (excluded.has(name) || (name.startsWith('.env') && name!=='.env.example')) continue
  const path=join(prefix,name), s=await lstat(join(root,path))
  if (s.isSymbolicLink()) throw new Error('Build input symlink must be made explicit: '+path)
  if (s.isDirectory()) rows.push(...await treeFiles(root,path))
  else if (s.isFile()) rows.push(path.replaceAll('\\','/'))
 }
 return rows
}
export async function snapshot(root,target) {
 const selected=[]
 // The offline interview checks require these packaged fixtures in the frozen workspace.
 // Keep other documentation and local experiment directories outside the build inputs.
 const evidenceFixtures=['docs/evidence/showcase-20261008','docs/evidence/showcase-candidate-20261008']
 for (const base of ['backend','frontend','verification','benchmarks','observability','.mvn','.github',...evidenceFixtures]) {
  for (const path of await treeFiles(join(root,base))) selected.push(base+'/'+path)
 }
 for (const path of ['mvnw','mvnw.cmd','.node-version','README.md','.gitignore','.gitattributes']) selected.push(path)
 const rows=[]
 for (const path of selected.sort()) {
  const bytes=await readFile(join(root,path)), dest=join(target,path)
  await mkdir(dirname(dest),{recursive:true});await writeFile(dest,bytes)
  if (path==='mvnw') await chmod(dest,0o755)
  rows.push({path,bytes:bytes.length,sha256:sha(bytes)})
 }
 return {sha256:sha(JSON.stringify(rows)),files:rows,cleanBuildInputs:true,
  excluded:['.git','.dev','node_modules','target','dist','local .env files','documentation outside the packaged verification evidence fixtures']}
}
export async function inventory(root) {
 const files=[]
 async function walk(dir) {
  for(const item of await readdir(dir,{withFileTypes:true})) {
   const p=join(dir,item.name)
   if(item.isDirectory())await walk(p)
   else if(item.isFile())files.push({path:relative(root,p).replaceAll('\\','/'),sha256:await fileHash(p)})
  }
 }
 await walk(root);return files.sort((a,b)=>a.path.localeCompare(b.path))
}
const terminationGraceMs=5000,terminationConfirmMs=1000,stdioCloseMs=1000
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function terminateGroup(pid) {
 const state={method:'process-group',pid,termSent:false,killSent:false,groupGone:false}
 const send=signal=>{
  try{process.kill(-pid,signal);return true}
  catch(e){if(e.code==='ESRCH')state.groupGone=true;else state.error=e.message;return false}
 }
 const waitGone=async budget=>{
  const deadline=performance.now()+budget
  do {
   send(0)
   if(state.groupGone)return true
   const remaining=deadline-performance.now()
   if(remaining<=0)return false
   await pause(Math.min(50,remaining))
  }while(true)
 }
 state.termSent=send('SIGTERM')
 if(state.groupGone||await waitGone(terminationGraceMs))return state
 state.killSent=send('SIGKILL')
 if(!state.groupGone&&!await waitGone(terminationConfirmMs))state.error ||= 'Process-group disappearance was not confirmed after SIGKILL (unreaped zombies can also keep a group present)'
 return state
}
async function terminateChild(pid) {
 if(!pid)return {method:'not-spawned'}
 if(process.platform!=='win32')return terminateGroup(pid)
 try {
  execFileSync('taskkill',['/PID',String(pid),'/T','/F'],{windowsHide:true,stdio:'ignore',timeout:10000})
  return {method:'taskkill',pid,confirmed:true}
 }catch(e){return {method:'taskkill',pid,confirmed:false,error:e.message}}
}
// Logs are streamed to disk. Stop completion belongs to the whole group, independently of parent close.
export async function runCommand(command,args,{cwd,env=process.env,log,timeoutMs=300000,signal}={}) {
 const stream=createWriteStream(log,{flags:'wx'}),start=performance.now()
 const child=spawn(command,args,{cwd,env,windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']})
 let timedOut=false,aborted=false,error,termination,timer,closed=false
 let result={exitCode:null,terminationSignal:null},stopFinished
 const stopped=new Promise(resolve=>{stopFinished=resolve})
 const completion=new Promise(resolve=>{
  child.once('error',e=>{error=e.message})
  child.once('exit',(exitCode,terminationSignal)=>{result={exitCode,terminationSignal}})
  child.once('close',(exitCode,terminationSignal)=>{closed=true;result={exitCode,terminationSignal};resolve()})
 })
 child.stdout?.pipe(stream,{end:false});child.stderr?.pipe(stream,{end:false})
 const stop=reason=>{
  if(termination)return // A later timeout/abort must not restart escalation or replace the first reason.
  timedOut=reason==='timeout';aborted=reason==='abort';clearTimeout(timer)
  termination=terminateChild(child.pid).catch(e=>({error:e.message}))
  termination.then(stopFinished)
 }
 timer=setTimeout(()=>stop('timeout'),timeoutMs)
 const abort=()=>stop('abort');signal?.addEventListener('abort',abort,{once:true})
 if(signal?.aborted)abort()
 await Promise.race([completion,stopped])
 clearTimeout(timer);signal?.removeEventListener('abort',abort)
 const terminationResult=await termination // Keep referenced escalation alive even if the parent already closed.
 if(!closed) {
  let closeTimer
  await Promise.race([completion,new Promise(resolve=>{closeTimer=setTimeout(resolve,stdioCloseMs)})])
  clearTimeout(closeTimer)
 }
 if(!closed){error ||= 'Direct child or stdio did not close within the termination budget';child.unref()}
 child.stdout?.unpipe(stream);child.stderr?.unpipe(stream)
 if(!closed){child.stdout?.destroy();child.stderr?.destroy()}
 error ||= terminationResult?.error
 await new Promise(resolve=>stream.end(resolve))
 return {...result,error,timedOut,aborted,termination:terminationResult,elapsedMs:performance.now()-start,
  passed:result.exitCode===0&&!timedOut&&!aborted&&!error}
}
export function commandFor(kind,args) {
 if (kind==='maven') return process.platform==='win32' ? ['cmd.exe',['/d','/s','/c','mvnw.cmd '+args.join(' ')]] : ['bash',['./mvnw',...args]]
 if (kind==='npm') return process.platform==='win32' ? ['cmd.exe',['/d','/s','/c','npm '+args.join(' ')]] : ['npm',args]
 return [kind,args]
}
export async function assertJar(path,expected) {if(await fileHash(path)!==expected)throw new Error('Frozen JAR changed: '+path)}
export function reportPassed(report) {
 return !report.error && report.steps.length>0 && report.steps.length===report.plannedSteps.length && report.steps.every(s=>s.status==='passed') && report.cleanup?.passed===true && !report.cleanup.forced
}
export function within(root,target) {
 const delta=relative(resolve(root),resolve(target))
 return delta!=='' && !delta.startsWith('..'+sep) && delta!=='..' && !resolve(target).startsWith('\\\\') && !delta.includes(':')
}

export function parseNodeTests(text) {
 const counts=Object.fromEntries(['tests','pass','fail','cancelled','skipped','todo'].map(key=>{
  const row=[...text.matchAll(new RegExp('^(?:# |ℹ )'+key+' (\\d+)\\r?$','gm'))].at(-1)
  return [key,Number(row?.[1])]
 }))
 if(Object.values(counts).some(v=>!Number.isSafeInteger(v)) || counts.tests<=0 || counts.pass!==counts.tests || ['fail','cancelled','skipped','todo'].some(k=>counts[k]!==0))throw new Error('Node tests must all pass with a complete summary and no skipped/TODO/cancelled cases')
 return counts
}
