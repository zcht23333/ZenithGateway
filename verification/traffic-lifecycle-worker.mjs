// Controlled side-effect-free upstream and audit reply-loss transport; isolated verification only.
import http from 'node:http'
import net from 'node:net'
import {readFileSync,createWriteStream} from 'node:fs'
const token=readFileSync('/secrets/zenith.admin.token','utf8').trim()
const arrivals=createWriteStream('/evidence/upstream.jsonl'),counts={},holds=new Map(),sockets=new Set()
let auditMode='normal',auditConnections=0,auditBytesSuppressed=0,received=0
function track(socket){sockets.add(socket);socket.on('error',()=>socket.destroy());socket.on('close',()=>sockets.delete(socket))}
const upstream=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://upstream'),parts=url.pathname.split('/').filter(Boolean),kind=parts[0],key=parts.slice(1).join('/')
 const entry={at:new Date().toISOString(),path:url.pathname,method:req.method,kind,key};received++;counts[key]=(counts[key]||0)+1
 if(arrivals.writableLength>4*1024*1024){res.destroy();throw new Error('Evidence writer bound exceeded')}
 arrivals.write(JSON.stringify({...entry,event:'received'})+'\n')
 let timer
 const closed=()=>{clearInterval(timer);holds.delete(key);arrivals.write(JSON.stringify({...entry,event:'closed',at:new Date().toISOString(),completed:res.writableFinished})+'\n')}
 res.once('close',closed)
 if(kind==='hold'||kind==='stream'){
  holds.set(key,{res,entry})
  if(kind==='stream'){res.writeHead(200,{'Content-Type':'text/plain'});res.write('part-0\n');let n=0;timer=setInterval(()=>{if(!res.destroyed)res.write('part-'+(++n)+'\n')},200)}
 }else{res.writeHead(200,{'Content-Type':'text/plain'});res.end('OK')}
})
upstream.on('connection',track);upstream.listen(8080,'0.0.0.0')
const audit=net.createServer(client=>{
 if(auditConnections>=16){client.destroy();return}
 auditConnections++;const backend=net.connect({host:'redis',port:6379});track(client);track(backend)
 client.pipe(backend)
 backend.on('data',chunk=>{if(auditMode==='drop-reply')auditBytesSuppressed+=chunk.length;else if(!client.destroyed){if(!client.write(chunk))backend.pause()}})
 client.on('drain',()=>backend.resume())
 client.once('close',()=>{auditConnections--;backend.destroy()});backend.once('close',()=>client.destroy())
})
audit.listen(6380,'0.0.0.0')
http.createServer(async(req,res)=>{
 if(req.headers.authorization!=='Bearer '+token){res.writeHead(401).end();return}
 const u=new URL(req.url,'http://control')
 if(req.method==='POST'&&u.pathname==='/audit-mode'){auditMode=u.searchParams.get('mode');if(!['normal','drop-reply'].includes(auditMode))throw new Error('Invalid audit mode')}
 if(req.method==='POST'&&u.pathname==='/release'){const h=holds.get(u.searchParams.get('key'));if(h&&!h.res.destroyed)h.res.end('DONE')}
 const body={received,counts,holds:[...holds.keys()],auditMode,auditConnections,auditBytesSuppressed}
 res.setHeader('Content-Type','application/json');res.end(JSON.stringify(body))
}).listen(8090,'0.0.0.0')
process.on('SIGTERM',()=>{for(const s of sockets)s.destroy();arrivals.end(()=>process.exit(0))})
