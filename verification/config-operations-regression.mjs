// Runs prior acceptance entrypoints against an isolated production preview; never overwrites old evidence.
import {preview} from '../frontend/node_modules/vite/dist/node/index.js'
import {spawn} from 'node:child_process'
import {mkdir,writeFile} from 'node:fs/promises'
import {createWriteStream} from 'node:fs'
import {createServer} from 'node:http'
import {resolve,join} from 'node:path'
import {randomUUID} from 'node:crypto'
const out=resolve('.dev/config-operations/compatibility-'+randomUUID().slice(0,8));await mkdir(out,{recursive:true})
const portServer=createServer();await new Promise(r=>portServer.listen(0,'127.0.0.1',r));const port=portServer.address().port;await new Promise(r=>portServer.close(r))
const ui=await preview({root:resolve('frontend'),configFile:false,preview:{host:'127.0.0.1',port,strictPort:true}})
const results=[]
try{
 for(const [entry,env] of [
  ['config-consistency-live.mjs',{CONFIG_CONSISTENCY_OUTPUT:join(out,'consistency')}],
  ['config-consistency-p2.mjs',{CONFIG_P2_OUTPUT:join(out,'p2'),CONFIG_P2_IMAGES:join(out,'p2/images')}],
  ['settings-stage-b.mjs',{SETTINGS_OUTPUT:join(out,'settings-preview'),SETTINGS_CAPTURE:'0',SETTINGS_RECORD:'0'}]
 ]){
  const log=createWriteStream(join(out,entry+'.log'))
  const child=spawn(process.execPath,['verification/'+entry],{windowsHide:true,env:{...process.env,ROUTE_CONSOLE_URL:'http://127.0.0.1:'+port,...env}})
  child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false})
  const exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)});log.end()
  results.push({entry,exitCode});console.log(entry+': '+exitCode)
  if(exitCode!==0){process.exitCode=1;break}
 }
}finally{await new Promise(r=>ui.httpServer.close(r));await writeFile(join(out,'report.json'),JSON.stringify({results,previewClosed:true},null,2)+'\n');console.log('Compatibility report: '+join(out,'report.json'))}
