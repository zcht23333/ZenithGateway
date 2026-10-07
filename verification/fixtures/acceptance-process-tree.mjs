// A real same-group descendant: readiness is acknowledged after its signal handler is installed.
import {spawn} from 'node:child_process'
import {writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
const [role,dir,stdio='ignore',cooperate='false']=process.argv.slice(2)
if(role==='worker') {
 let ticks=0
 process.on('SIGTERM',()=>{
  writeFileSync(join(dir,'worker-term.json'),JSON.stringify({pid:process.pid,at:Date.now()}))
  if(cooperate==='true')process.exit(0)
 })
 const beat=()=>writeFileSync(join(dir,'heartbeat'),String(++ticks))
 beat();setInterval(beat,20)
 if(process.send){process.send('ready');process.disconnect()}
 else writeFileSync(join(dir,'ready.json'),JSON.stringify({pid:process.pid}))
} else {
 const worker=spawn(process.execPath,[fileURLToPath(import.meta.url),'worker',dir,stdio,cooperate],
  {stdio:['ignore',stdio,stdio,'ipc'],windowsHide:true}) // No detached: the worker inherits the command's group.
 worker.once('message',()=>writeFileSync(join(dir,'ready.json'),JSON.stringify({parentPid:process.pid,childPid:worker.pid})))
 process.on('SIGTERM',()=>{
  writeFileSync(join(dir,'parent-term.json'),JSON.stringify({pid:process.pid,childPid:worker.pid,at:Date.now()}))
  if(cooperate==='true'&&worker.exitCode===null&&worker.signalCode===null)worker.once('exit',()=>process.exit(0))
  else process.exit(0)
 })
 setInterval(()=>{},1000)
}
