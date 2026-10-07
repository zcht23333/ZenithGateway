import {runtimeFixture} from './runtime-config-client.mjs'
import {createServer} from 'node:http'
import {readFile,mkdir,writeFile} from 'node:fs/promises'
import {resolve,extname} from 'node:path'
import {gzipSync} from 'node:zlib'
import {chromium} from '../.dev/browser/node_modules/playwright/index.mjs'
import assert from 'node:assert/strict'
const label=process.env.STAGE_C_PHASE||'before'
const root=resolve(label==='before'?'.dev/stage-c/dist-before':'frontend/dist')
const out='.dev/stage-c'
await mkdir(out,{recursive:true})
const runtime=runtimeFixture({rateLimitEnabled:true,replenishRate:20,burstCapacity:20,requestedTokens:1,monitorWindowSeconds:10,emitIntervalSeconds:1})
const now=Date.now()
const series=Array.from({length:30},(_,i)=>({timestamp:now-(29-i)*1000,enabled:true,windowSeconds:10,requestCount:200,qps:20,avgLatencyMs:12,p95LatencyMs:24+i%12}))
const status={enabled:true,accepting:true,received:200,persisted:200,dropped:0,uncertain:0,pending:0,queueDepth:0,inFlight:0,oldestAgeMs:0}
const api=[]
const server=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://local'),path=url.pathname
 if(path.startsWith('/api/')){
  api.push({method:req.method,path})
  if(path==='/api/monitor/stream'){
   res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'})
   res.write('event: traffic\ndata: '+JSON.stringify(series.at(-1))+'\n\n');return
  }
  const authorized=req.headers.authorization==='Bearer network-stage-c'
  const data=path.endsWith('/runtime')?runtime:path.endsWith('/series')?series:path.endsWith('/snapshot')?series.at(-1):path.endsWith('/status')?status:path.endsWith('/sse-token')?{token:'isolated-network-ticket'}:[]
  res.writeHead(authorized?200:401,{'Content-Type':'application/json'});res.end(JSON.stringify(authorized?data:{message:'需要管理认证'}));return
 }
 try{
  const file=path.startsWith('/assets/')?resolve(root,'.'+path):resolve(root,'index.html')
  if(!file.startsWith(root+ '\\')&&!file.startsWith(root+'/'))throw new Error('outside build')
  const content=await readFile(file),body=gzipSync(content)
  res.writeHead(200,{'Content-Type':extname(file)==='.js'?'text/javascript':extname(file)==='.css'?'text/css':'text/html; charset=utf-8','Content-Encoding':'gzip','Content-Length':body.length,'Cache-Control':'no-store'})
  res.end(body)
 }catch{res.writeHead(404);res.end()}
})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const base='http://127.0.0.1:'+server.address().port
const browser=await chromium.launch({channel:'msedge',headless:true})
const report={phase:label,buildRoot:root,compression:'gzip',cache:'disabled; fresh browser context for each direct entry',api:'isolated fixture; actual authentication gate and Bearer exchange; no production API',entries:[],errors:[]}
try{
 for(const [name,path,ready] of [['login','/','#admin-token'],['settings','/settings','#setting-replenishRate'],['overview','/','.overview-chart canvas']]){
  const ctx=await browser.newContext({viewport:{width:1440,height:900}}),p=await ctx.newPage()
  const cdp=await ctx.newCDPSession(p);await cdp.send('Network.enable');await cdp.send('Network.setCacheDisabled',{cacheDisabled:true})
  const requests=new Map()
  cdp.on('Network.requestWillBeSent',e=>requests.set(e.requestId,{path:new URL(e.request.url).pathname,type:e.type,initiator:e.initiator.type}))
  cdp.on('Network.responseReceived',e=>Object.assign(requests.get(e.requestId)||{},{status:e.response.status,encodedBodyBytes:Number(e.response.headers['Content-Length']||e.response.headers['content-length']||0)}))
  cdp.on('Network.loadingFinished',e=>Object.assign(requests.get(e.requestId)||{},{wireBytes:e.encodedDataLength}))
  p.on('pageerror',e=>report.errors.push(e.message))
  await p.goto(base+path);await p.locator('#admin-token').waitFor();await p.waitForTimeout(200)
  const loginAssets=[...requests.values()].filter(r=>r.path.startsWith('/assets/')).map(r=>({...r}))
  if(name!=='login'){
   await p.locator('#admin-token').fill('network-stage-c');await p.getByRole('button',{name:'连接',exact:true}).click()
   await p.locator(ready).waitFor();if(name==='settings')await p.waitForFunction(()=>document.querySelector('#setting-replenishRate')?.disabled===false)
  }
  await p.waitForTimeout(400)
  const assets=[...requests.values()].filter(r=>r.path.startsWith('/assets/'))
  const sum=(files,key)=>files.reduce((a,b)=>a+(b[key]||0),0)
  report.entries.push({name,directPath:path,loginAssets,assets,compressedAssetBytes:sum(assets,'encodedBodyBytes'),wireAssetBytes:sum(assets,'wireBytes'),additionalAfterAuthentication:assets.filter(a=>!loginAssets.some(b=>a.path===b.path))})
  await ctx.close()
 }
 const ctx=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce'}),p=await ctx.newPage()
 await p.goto(base+'/overview/preview?scenario=overflow');await p.locator('.overview-chart canvas').waitFor();await p.waitForTimeout(150)
 await p.screenshot({path:'docs/images/stage-c-p95-'+label+'-1440.png'})
 await p.setViewportSize({width:390,height:844})
 await p.goto(base+'/settings/preview');await p.waitForFunction(()=>document.querySelector('#setting-replenishRate')?.value==='20')
 await p.locator('#setting-replenishRate').fill('40');await p.locator('#setting-monitorWindowSeconds').fill('30')
 await p.evaluate(()=>{document.activeElement?.blur();scrollTo(0,0)})
 await p.screenshot({path:'docs/images/stage-c-mobile-'+label+'-390.png'})
 await ctx.close()
 assert.deepEqual(report.errors,[])
 report.passed=true
}finally{
 await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r))
 await writeFile(out+'/network-'+label+'.json',JSON.stringify(report,null,2)+'\n')
}
console.log(JSON.stringify(report.entries.map(({name,compressedAssetBytes,assets})=>({name,compressedAssetBytes,assets:assets.map(a=>a.path)})),null,2))
