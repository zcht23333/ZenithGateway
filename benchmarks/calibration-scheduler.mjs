// Read-only, bounded scheduler evidence for the single diagnostic pair; never runs during capacity phases.
import {readFile,writeFile} from 'node:fs/promises'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {resolve,join} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {createHash} from 'node:crypto'
const exec=promisify(execFile),root=resolve(process.argv[2]),raw=JSON.parse(await readFile(join(root,'calibration/summary.json'),'utf8'))
const report={startedAt:new Date().toISOString(),sourceSha256:createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),scope:'Only targeted A/B phases; excludes capacity measurements',maxSamplesPerMode:24,intervalMs:10000,modes:{},errors:[],finished:false}
const script=`printf 'CLOCK '; date -u +%s%3N
printf 'SCHEDSTATS '; cat /proc/sys/kernel/sched_schedstats 2>/dev/null || true
printf 'CPU '; cat /sys/fs/cgroup/cpu.stat
n=0
for taskPath in /proc/1/task/[0-9]*; do
  n=$((n+1)); if [ "$n" -gt 128 ]; then printf 'TRUNCATED\n'; break; fi
  IFS= read -r threadName < "$taskPath/comm" || continue
  read -r runNs waitNs slices < "$taskPath/schedstat" || continue
  printf 'THREAD %s|%s|%s|%s|%s\n' "\${taskPath##*/}" "$threadName" "$runNs" "$waitNs" "$slices"
done`
const end=Date.now()+80*60*1000;let current,lastSample=0
try{
 while(Date.now()<end){
  const log=await readFile(join(root,'calibration.log'),'utf8');const lines=log.trim().split('\n')
  if(lines.some(l=>l.startsWith('Capacity calibration evidence:')))break
  const latest=lines.findLast(l=>l.startsWith('START ')||l.startsWith('RESULT '))||''
  const match=latest.match(/^START targeted-([AB])-4000 /)
  if(match){
   const label=match[1];current=label;report.modes[label]??=[]
   if(Date.now()-lastSample>=report.intervalMs&&report.modes[label].length<report.maxSamplesPerMode){
    const g=raw.gateways.find(g=>g.label===label);if(!g)throw new Error('Measured instance missing: '+label)
    const began=Date.now()
    try{const {stdout}=await exec('docker',['exec',g.name,'sh','-c',script],{windowsHide:true,timeout:5000,maxBuffer:1024*1024});report.modes[label].push({collectedAt:new Date().toISOString(),elapsedMs:Date.now()-began,raw:stdout})}
    catch(error){report.errors.push({label,at:new Date().toISOString(),message:error.message})}
    lastSample=Date.now();await writeFile(join(root,'scheduler-evidence.json'),JSON.stringify(report,null,2)+'\n')
   }
  }
  if(current==='B'&&lines.some(l=>l.startsWith('RESULT targeted-B-4000 ')))break
  await delay(2000)
 }
 report.finished=true;report.finishedAt=new Date().toISOString()
}finally{await writeFile(join(root,'scheduler-evidence.json'),JSON.stringify(report,null,2)+'\n')}
console.log(JSON.stringify({modes:Object.fromEntries(Object.entries(report.modes).map(([k,v])=>[k,v.length])),errors:report.errors.length}))
