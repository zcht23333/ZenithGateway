import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {treeFiles,fileHash,runCommand,assertJar,reportPassed,within,parseNodeTests} from './acceptance-core.mjs'
import {requiredImages,releaseChecks,validateLiveReport} from './acceptance-plan.mjs'
import {cleanupCredentials,auditHostResources} from './acceptance-cleanup.mjs'
import {scopedDockerArgs} from './acceptance-scope.mjs'
async function temp(fn){const dir=await mkdtemp(join(tmpdir(),'zenith-acceptance-test-'));try{await fn(dir)}finally{assert(within(tmpdir(),dir));await rm(dir,{recursive:true,force:true})}}
test('snapshot inputs omit installed/generated files and secrets but retain actual image assets',()=>temp(async dir=>{
 for(const p of ['src/assets/images/icon.svg','src/app.js','node_modules/lib.js','target/app.jar','dist/app.js','.env','.env.local','.env.example']){const f=join(dir,p);await mkdir(join(f,'..'),{recursive:true});await writeFile(f,'input')}
 assert.deepEqual(await treeFiles(dir),['.env.example','src/app.js','src/assets/images/icon.svg'])
}))
test('snapshot rejects a symlink instead of reading outside the selected source tree',()=>temp(async dir=>{
 await mkdir(join(dir,'real'));await writeFile(join(dir,'real','input'),'data');await symlink(join(dir,'real'),join(dir,'linked'),'junction')
 await assert.rejects(treeFiles(dir),/symlink/)
}))
test('cleanup path checks reject roots, parents and sibling-prefix paths',()=>{
 assert(!within('/tmp/check','/tmp/check'));assert(!within('/tmp/check','/tmp/check-other/file'));assert(!within('/tmp/check','/tmp/check/../file'));assert(within('/tmp/check','/tmp/check/log'))
})
test('images are pinned and commit includes Prometheus preparation even without release checks',()=>{
 const values=requiredImages('commit');assert.equal(values.length,2);assert(values.some(x=>x.startsWith('prom/prometheus:')))
 assert(requiredImages('release').every(x=>/@sha256:[0-9a-f]{64}$/.test(x)));assert.throws(()=>requiredImages('typo'))
})
test('release matrix is unique, serial, bounded and explicitly excludes capacity experiments',()=>{
 assert.equal(new Set(releaseChecks.map(x=>x.id)).size,releaseChecks.length)
 for(const c of releaseChecks){assert(c.timeoutMs>0&&c.timeoutMs<=420000);assert(c.cleanup.length>0);assert.notEqual(c.mode,'cold')}
 assert(releaseChecks.some(x=>x.id==='config-rollback'&&x.backendOnly));assert(releaseChecks.some(x=>x.id==='lifecycle-signal'))
})
test('ownership labels only creation, preserves standalone calls, and rejects malformed scope',()=>{
 const env={ZENITH_ACCEPTANCE_SCOPE:'zg-12345678-1234-1234-1234-123456789abc'}
 assert.deepEqual(scopedDockerArgs(['run','--rm','image'],{}),['run','--rm','image'])
 assert.deepEqual(scopedDockerArgs(['run','--rm','image'],env),['run','--label','zenith.acceptance='+env.ZENITH_ACCEPTANCE_SCOPE,'--rm','image'])
 assert.equal(scopedDockerArgs(['network','create','net'],env)[2],'--label')
 assert.deepEqual(scopedDockerArgs(['rm','-f','owned'],env),['rm','-f','owned']);assert.throws(()=>scopedDockerArgs(['run'],{ZENITH_ACCEPTANCE_SCOPE:'*'}))
})
const check={id:'probe',cleanup:['redisRemoved']},good={passed:true,jarSha256:'frozen',checks:['one'],cleanup:{redisRemoved:true},notExecuted:['browser']}
test('live reports must confirm execution, the frozen package and every required cleanup fact',()=>{
 assert.equal(validateLiveReport(good,check,'frozen').checks,1)
 for(const changed of [{passed:false},{checks:[]},{jarSha256:'other'},{cleanup:{}},{cleanup:{redisRemoved:true,backendExitCode:null}}])assert.throws(()=>validateLiveReport({...good,...changed},check,'frozen'))
 assert.deepEqual(validateLiveReport(good,check,'frozen').notExecuted,['browser'])
})
test('empty reports, missing steps, skipped steps or failed cleanup never pass',()=>{
 const base={plannedSteps:['check'],steps:[{name:'check',status:'passed'}],cleanup:{passed:true}}
 assert(reportPassed(base));assert(!reportPassed({...base,steps:[]}));assert(!reportPassed({...base,steps:[{status:'not_run'}]}));assert(!reportPassed({...base,cleanup:{passed:false}}));assert(!reportPassed({...base,cleanup:{passed:true,forced:true}}));assert(!reportPassed({...base,error:'lost result'}));assert(!reportPassed({plannedSteps:[],steps:[],cleanup:{passed:true}}))
})
test('artifact mutation is detected, including a later suite replacing the target JAR',()=>temp(async dir=>{
 const p=join(dir,'app.jar');await writeFile(p,'original');const hash=await fileHash(p);await assertJar(p,hash);await writeFile(p,'replacement');await assert.rejects(assertJar(p,hash),/changed/)
}))
test('failed child retains its exact exit and log rather than disappearing from the report',()=>temp(async dir=>{
 const log=join(dir,'failure.log'),r=await runCommand(process.execPath,['-e',"console.error('expected failure');process.exit(17)"],{cwd:dir,log,timeoutMs:5000})
 assert.equal(r.exitCode,17);assert(!r.passed);assert(!r.timedOut);assert.match(await readFile(log,'utf8'),/expected failure/)
}))
test('a timed-out child is ended within its budget and cannot be reported as passing',()=>temp(async dir=>{
 const r=await runCommand(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:dir,log:join(dir,'timeout.log'),timeoutMs:300})
 assert(r.timedOut);assert(!r.passed);assert(r.elapsedMs<10000)
}))
test('missing executable produces a failed result with diagnostic output instead of hanging',()=>temp(async dir=>{
 const r=await runCommand(join(dir,'missing-executable'),[],{cwd:dir,log:join(dir,'spawn.log'),timeoutMs:1000})
 assert(!r.passed);assert.match(r.error,/ENOENT/)
}))

test('failed live checks remove only owned private files and retain public evidence',()=>temp(async dir=>{
 const base=join(dir,'checks/proxy-resilience');await mkdir(base,{recursive:true});await writeFile(join(base,'upstream.p12'),'private test key');await writeFile(join(base,'upstream.pem'),'public certificate')
 const result=await cleanupCredentials(dir);assert.deepEqual(result.removed,['checks/proxy-resilience/upstream.p12']);assert.equal(await readFile(join(base,'upstream.pem'),'utf8'),'public certificate')
 assert.deepEqual((await cleanupCredentials(dir)).removed,[])
}))

test('TAP/spec summaries require real passes; TODO, skipped, cancelled or incomplete summaries cannot look healthy',()=>{
 const summary={tests:2,pass:2,fail:0,cancelled:0,skipped:0,todo:0}
 const render=(counts,prefix='# ')=>Object.entries(counts).map(([k,v])=>prefix+k+' '+v).join('\n')+'\n'
 assert.deepEqual(parseNodeTests(render(summary)),summary)
 assert.deepEqual(parseNodeTests(render(summary,'ℹ ')),summary)
 for(const changed of [{todo:1,pass:1},{skipped:1,pass:1},{cancelled:1,pass:1},{fail:1,pass:1},{tests:0,pass:0},{pass:1}])assert.throws(()=>parseNodeTests(render({...summary,...changed})))
 assert.throws(()=>parseNodeTests('# tests 1\n# fail 0\n'))
 assert.deepEqual(parseNodeTests('# tests 999\n'+render(summary)),summary)
})

test('unlabelled volume leaks and unrelated container changes cannot pass cleanup or be silently pruned',()=>{
 const before={containers:['old running'],volumes:['old-volume'],networks:['old-bridge'],images:['old-image']}
 assert(auditHostResources(before,structuredClone(before)).passed)
 const leaked=auditHostResources(before,{...before,volumes:['old-volume','anonymous-leak']})
 assert(!leaked.passed);assert.deepEqual(leaked.volumes.added,['anonymous-leak'])
 assert(!auditHostResources(before,{...before,volumes:[]}).passed)
 assert(!auditHostResources(before,{...before,containers:['old stopped']}).passed)
 const drift=auditHostResources(before,{...before,networks:['new-bridge'],images:['old-image','cache']})
 assert(drift.passed);assert.deepEqual(drift.networks.removed,['old-bridge']);assert.deepEqual(drift.networks.added,['new-bridge'])
 assert.deepEqual(before.volumes,['old-volume'])
})

const processFixture=fileURLToPath(new URL('./fixtures/acceptance-process-tree.mjs',import.meta.url))
async function until(label,probe,budget=4000) {
 const deadline=performance.now()+budget
 do{try{const value=await probe();if(value)return value}catch{};await new Promise(r=>setTimeout(r,20))}while(performance.now()<deadline)
 throw new Error('Condition not reached: '+label)
}
async function executing(pid) {
 if(!pid)return false
 try {
  process.kill(pid,0)
  if(process.platform==='linux') {
   const stat=await readFile('/proc/'+pid+'/stat','utf8'),state=stat.slice(stat.lastIndexOf(')')+2).split(' ')[0]
   return !['Z','X'].includes(state) // An unreaped zombie cannot write; kill(pid, 0) alone is not a liveness assertion.
  }
  return true
 }catch(e){if(['ESRCH','ENOENT'].includes(e.code))return false;throw e}
}
for(const reason of ['timeout','abort'])for(const stdio of ['ignore','inherit']) {
 test(reason+' awaits a TERM-resistant descendant with '+stdio+' stdio after its parent exits',{timeout:20000},()=>temp(async dir=>{
  const controller=new AbortController(),timeoutMs=1500
  let ids,control,controlDir
  // The separate group must continue working when only the command's group is stopped.
  if(reason==='timeout'&&stdio==='ignore') {
   controlDir=join(dir,'unrelated');await mkdir(controlDir)
   control=spawn(process.execPath,[processFixture,'worker',controlDir],{detached:true,stdio:'ignore',windowsHide:true})
  }
  const pending=runCommand(process.execPath,[processFixture,'parent',dir,stdio],{
   cwd:dir,log:join(dir,'tree.log'),timeoutMs,signal:controller.signal})
  try {
   ids=await until('descendant signal handler installed',async()=>JSON.parse(await readFile(join(dir,'ready.json'),'utf8')))
   if(control)await until('independent group ready',()=>readFile(join(controlDir,'ready.json'),'utf8'))
   if(reason==='abort')controller.abort()
   const result=await pending
   assert.equal(result.passed,false);assert.equal(result.timedOut,reason==='timeout');assert.equal(result.aborted,reason==='abort')
   assert.equal(await executing(ids.childPid),false,'runCommand returned while the descendant was still executing')
   const beat=await readFile(join(dir,'heartbeat'),'utf8')
   if(control){
    const before=await readFile(join(controlDir,'heartbeat'),'utf8')
    await until('unrelated group still executes',async()=>(await readFile(join(controlDir,'heartbeat'),'utf8'))!==before)
    assert.equal(await executing(control.pid),true)
   }
   assert.equal(await readFile(join(dir,'heartbeat'),'utf8'),beat)
   if(process.platform!=='win32') {
    assert.equal(result.exitCode,0,'the direct parent handled TERM and exited before escalation')
    assert.equal(result.termination.termSent,true);assert.equal(result.termination.killSent,true)
    assert(await readFile(join(dir,'parent-term.json'),'utf8'))
    assert(await readFile(join(dir,'worker-term.json'),'utf8'))
    assert(result.elapsedMs>=5000,'escalation must remain awaited and referenced after parent close')
   }
   assert(result.elapsedMs<12000,'termination and pipe closure have bounded budgets')
  }finally{
   controller.abort();await pending
   if(ids&&await executing(ids.childPid)){try{process.kill(ids.childPid,'SIGKILL')}catch{}}
   if(control){const ended=new Promise(r=>control.once('close',r));if(control.exitCode===null&&control.signalCode===null){control.kill('SIGKILL');await ended}}
  }
 }))
}
test('cooperative cancellation and normal completion do not wait for an unnecessary escalation',{timeout:10000},()=>temp(async dir=>{
 const controller=new AbortController()
 const pending=runCommand(process.execPath,[processFixture,'parent',dir,'ignore','true'],{
  cwd:dir,log:join(dir,'cooperative.log'),timeoutMs:5000,signal:controller.signal})
 try {
  const ids=await until('cooperative descendant ready',async()=>JSON.parse(await readFile(join(dir,'ready.json'),'utf8')))
  controller.abort();const result=await pending
  assert(result.aborted);assert(!result.timedOut);assert(!result.passed);assert(!await executing(ids.childPid))
  if(process.platform!=='win32'){assert(result.termination.groupGone);assert(!result.termination.killSent)}
  assert(result.elapsedMs<5000)
  const normal=await runCommand(process.execPath,['-e',"console.log('completed')"],{cwd:dir,log:join(dir,'normal.log'),timeoutMs:5000})
  assert(normal.passed);assert.equal(normal.exitCode,0);assert.equal(normal.termination,undefined)
 }finally{controller.abort();await pending}
}))
