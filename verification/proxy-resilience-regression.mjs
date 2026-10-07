// Serial regressions, with a private production preview and new evidence directories.
import {preview} from '../frontend/node_modules/vite/dist/node/index.js'
import {spawn} from 'node:child_process'
import {createWriteStream} from 'node:fs'
import {mkdir,writeFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {randomUUID} from 'node:crypto'
const out=resolve('.dev/proxy-resilience/regression-'+randomUUID().slice(0,8));await mkdir(out,{recursive:true})
const report={startedAt:new Date().toISOString(),results:[],passed:false};let ui
try {
 for(const entry of ['config-rollback-regression.mjs','route-dispatch.mjs','route-dispatch-live.mjs']) {
  if(entry==='route-dispatch.mjs')ui=await preview({root:resolve('frontend'),configFile:false,preview:{host:'127.0.0.1',port:0}})
  const port=ui?.httpServer.address().port,log=createWriteStream(join(out,entry+'.log'))
  const env={...process.env,...(port?{ROUTE_CONSOLE_URL:'http://127.0.0.1:'+port}:{}),
   ROUTE_DISPATCH_OUTPUT:join(out,'routes-preview'),ROUTE_DISPATCH_IMAGES:join(out,'images'),
   ROUTE_DISPATCH_LIVE_OUTPUT:join(out,'routes-live'),ROUTE_DISPATCH_LIVE_IMAGE:join(out,'routes-live','screen.png')}
  console.log('START '+entry)
  const child=spawn(process.execPath,['verification/'+entry],{windowsHide:true,env})
  child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false})
  const exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)})
  await new Promise(r=>log.end(r));report.results.push({entry,exitCode,log:join(out,entry+'.log')})
  console.log('DONE '+entry+' '+exitCode);if(exitCode!==0){process.exitCode=1;break}
 }
 report.passed=report.results.length===3&&report.results.every(r=>r.exitCode===0)
}finally{
 if(ui)await new Promise(r=>ui.httpServer.close(r));report.previewClosed=true;report.completedAt=new Date().toISOString()
 await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log('Regression report: '+join(out,'report.json'))
}
