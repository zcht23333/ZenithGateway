import http from 'node:http'
import net from 'node:net'
import {readFile,writeFile} from 'node:fs/promises'
import {stabilityLoad} from './stability-load.mjs'
const role=process.argv[2]
const listen=(server,port)=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'0.0.0.0',resolve)})
if(role==='load'){
 const config=JSON.parse(await readFile('/evidence/load-config.json','utf8'))
 const result=await stabilityLoad({...config,onStarted:meta=>console.log(JSON.stringify({kind:'started',...meta}))})
 await writeFile('/evidence/load-result.json',JSON.stringify(result,null,2)+'\n')
 console.log(JSON.stringify({kind:'completed',requests:result.finished,misses:result.schedulerMisses+result.capacityMisses}))
}else if(role==='upstream'||role==='proxy'){
 const token=(await readFile('/run/admin-token','utf8')).trim()
 const stats={role,requests:0,active:0,peakActive:0,sockets:0,peakSockets:0,timers:0,peakTimers:0,pendingBytes:0,peakPendingBytes:0,overflow:0}
 const state={delayMs:0,disconnected:false}
 const sockets=new Set()
 function track(s){sockets.add(s);stats.sockets=sockets.size;stats.peakSockets=Math.max(stats.peakSockets,stats.sockets);s.on('error',()=>s.destroy());s.on('close',()=>{sockets.delete(s);stats.sockets=sockets.size})}
 const control=http.createServer(async(req,res)=>{
  if(req.headers.authorization!=='Bearer '+token){res.writeHead(401);res.end();return}
  try{
   if(req.method==='POST'){
    let body='';for await(const chunk of req){body+=chunk;if(body.length>4096)throw new Error('Control payload too large')}
    const data=JSON.parse(body)
    if(data.delayMs!==undefined){if(!Number.isInteger(data.delayMs)||data.delayMs<0||data.delayMs>10000)throw new Error('Invalid delay');state.delayMs=data.delayMs}
    if(data.disconnected!==undefined){if(typeof data.disconnected!=='boolean')throw new Error('Invalid disconnected');state.disconnected=data.disconnected}
    if(state.disconnected)for(const s of sockets)s.destroy()
   }
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify({state,stats,memory:process.memoryUsage(),cpu:process.cpuUsage(),at:new Date().toISOString()}))
  }catch(e){res.writeHead(400);res.end(JSON.stringify({error:e.message}))}
 })
 await listen(control,8090)
 if(role==='upstream'){
  for(const [port,label] of [[8080,'V1'],[8081,'V2']]){
   const server=http.createServer((req,res)=>{
    stats.requests++;stats.active++;stats.peakActive=Math.max(stats.peakActive,stats.active)
    let timer,done=false
    const settle=()=>{if(done)return;done=true;stats.active--;if(timer){clearTimeout(timer);stats.timers--;timer=null}}
    res.once('close',settle);res.once('finish',settle)
    const send=()=>{if(timer){stats.timers--;timer=null}if(!res.destroyed){res.setHeader('Content-Type','text/plain');res.setHeader('X-Upstream-Version',label);res.end(label+':'+req.url+':'+'x'.repeat(128))}}
    if(state.disconnected){req.socket.destroy();return}
    if(state.delayMs){stats.timers++;stats.peakTimers=Math.max(stats.peakTimers,stats.timers);timer=setTimeout(send,state.delayMs)}else send()
   })
   server.on('connection',track);await listen(server,port)
  }
 }else{
  const server=net.createServer(client=>{
   if(state.disconnected){client.destroy();return}
   const upstream=net.connect({host:'redis',port:6379});track(client);track(upstream)
   const timers=new Map();let pendingBytes=0
   const finishTimer=(timer,length)=>{if(!timers.delete(timer))return;pendingBytes-=length;stats.pendingBytes-=length;stats.timers--}
   const clear=()=>{for(const [timer,length] of timers){clearTimeout(timer);finishTimer(timer,length)}}
   client.pipe(upstream)
   upstream.on('data',chunk=>{
    if(!state.delayMs){if(!client.write(chunk))upstream.pause();return}
    if(timers.size>=1024||pendingBytes+chunk.length>2*1024*1024){stats.overflow++;client.destroy();return}
    pendingBytes+=chunk.length;stats.pendingBytes+=chunk.length;stats.peakPendingBytes=Math.max(stats.peakPendingBytes,stats.pendingBytes)
    if(pendingBytes>=1024*1024)upstream.pause()
    stats.timers++;stats.peakTimers=Math.max(stats.peakTimers,stats.timers)
    const timer=setTimeout(()=>{finishTimer(timer,chunk.length);if(client.destroyed)return;if(!client.write(chunk))upstream.pause();else if(pendingBytes<1024*1024)upstream.resume()},state.delayMs)
    timers.set(timer,chunk.length)
   })
   client.on('drain',()=>{if(pendingBytes<1024*1024)upstream.resume()})
   client.on('close',()=>{clear();upstream.destroy()});upstream.on('close',()=>client.destroy())
  })
  await listen(server,6379)
 }
 console.log(JSON.stringify({kind:'ready',role}))
}else throw new Error('Unknown capacity worker role')
