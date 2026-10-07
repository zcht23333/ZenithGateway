// Test-only upstream plus two bounded Redis wires. No production business requests are generated here.
import http from 'node:http'
import net from 'node:net'
import {readFileSync,createWriteStream} from 'node:fs'
const token=readFileSync('/secrets/zenith.admin.token','utf8').trim(),events=[],holds=new Map(),sockets=new Set()
const log=createWriteStream('/evidence/upstream.jsonl');let partitionB=false,auditMode='normal',suppressed=0
const bPairs=new Set(),auditPairs=new Set()
function track(s){sockets.add(s);s.on('error',()=>s.destroy());s.once('close',()=>sockets.delete(s));return s}
function record(row){if(events.length>=50000||log.writableLength>4*1024*1024)throw new Error('Evidence bound');events.push(row);log.write(JSON.stringify(row)+'\n')}
const upstream=http.createServer((req,res)=>{
 const path=new URL(req.url,'http://upstream').pathname,[,kind,id]=path.split('/'),instance=req.headers['x-verification-instance']
 const row={at:new Date().toISOString(),path,id,kind,instance,method:req.method,remotePort:req.socket.remotePort}
 record(row)
 res.once('close',()=>{row.closedAt=new Date().toISOString();row.writableEnded=res.writableEnded;holds.delete(id)})
 if(kind==='hold'||kind==='stream'){
  if(holds.size>=64){res.destroy();return}holds.set(id,res)
  if(kind==='stream'){res.writeHead(200,{'Content-Type':'text/plain'});res.write('part-0\n')}
 }else if(kind==='write-loss'){res.destroy()}
 else{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id,instance,method:req.method}))}
})
upstream.on('connection',track);upstream.listen(8080,'0.0.0.0')
function wire(port,pairs,isB){
 net.createServer(client=>{
  if(pairs.size>=64||(isB&&partitionB)){client.destroy();return}
  track(client);const remote=track(net.connect({host:'redis',port:6379})),pair={client,remote};pairs.add(pair)
  const close=()=>{client.destroy();remote.destroy();pairs.delete(pair)}
  client.once('close',close);remote.once('close',close)
  client.pipe(remote)
  remote.on('data',bytes=>{if(!isB&&auditMode==='drop-reply'){suppressed+=bytes.length;return}if(!client.write(bytes))remote.pause()})
  client.on('drain',()=>remote.resume())
 }).listen(port,'0.0.0.0')
}
wire(6381,bPairs,true);wire(6382,auditPairs,false)
http.createServer(async(req,res)=>{
 if(req.headers.authorization!=='Bearer '+token){res.writeHead(401).end();return}
 try{
  const url=new URL(req.url,'http://control');let text=''
  if(req.method==='POST'){for await(const b of req){text+=b;if(text.length>4096)throw new Error('Input bound')}
   const v=text?JSON.parse(text):{}
   if(url.pathname==='/redis'){partitionB=!!v.partitionB;auditMode=v.auditMode||'normal';if(!['normal','drop-reply'].includes(auditMode))throw new Error('Bad mode');if(partitionB)for(const p of bPairs){p.client.destroy();p.remote.destroy()}}
   else if(url.pathname==='/release'){const r=holds.get(v.id);if(r&&!r.destroyed)r.end('DONE')}
   else if(url.pathname==='/pulse'){const r=holds.get(v.id);if(r&&!r.destroyed)r.write('part-1\n')}
   else throw new Error('Unknown control')
  }
  const phase=url.searchParams.get('phase'),rows=phase?events.filter(e=>e.id.startsWith(phase+'-')):events
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({received:events.length,holds:[...holds.keys()],partitionB,auditMode,suppressed,bConnections:bPairs.size,auditConnections:auditPairs.size,rows}))
 }catch(e){res.writeHead(400).end(JSON.stringify({error:e.message}))}
}).listen(8090,'0.0.0.0')
process.once('SIGTERM',()=>{for(const s of sockets)s.destroy();log.end(()=>process.exit(0));setTimeout(()=>process.exit(1),1000)})
