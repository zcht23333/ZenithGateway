import net from 'node:net'
function frame(b,o=0){const e=b.indexOf('\r\n',o);if(e<0)return null;const t=String.fromCharCode(b[o]),s=b.toString('utf8',o+1,e);let n=e+2,v=s
 if(['$','!','='].includes(t)){const l=Number(s);if(l<0)return {n,v:null,t};if(b.length<n+l+2)return null;v=b.toString('utf8',n,n+l);n+=l+2}
 else if(['*','%','~','>','|'].includes(t)){v=[];for(let i=0;i<Number(s)*(t==='%'||t==='|'?2:1);i++){const x=frame(b,n);if(!x)return null;v.push(x.v);n=x.n}}
 else if(t===':')v=Number(s);return {n,v,t}}
export async function routeProxy(port,key){
 const connections=new Set(),events=[];let sequence=0,partitioned=false,gate=null,dropWrite=false,holdReads=false,peakRouteConnections=0
 const server=net.createServer(client=>{
  if(partitioned){client.destroy();return}
  const upstream=net.connect({host:'127.0.0.1',port}),c={id:++sequence,client,upstream,name:null,input:Buffer.alloc(0),output:Buffer.alloc(0),pending:[],held:[],closed:false};connections.add(c)
  const close=()=>{if(c.closed)return;c.closed=true;for(const h of c.held)if(!h.event.releasedAt)h.event.closedBeforeRelease=true;client.destroy();upstream.destroy();connections.delete(c)}
  for(const s of [client,upstream]){s.on('error',close);s.on('close',close)}
  client.on('data',chunk=>{c.input=Buffer.concat([c.input,chunk]);let f;while((f=frame(c.input))){
   const bytes=c.input.subarray(0,f.n);c.input=c.input.subarray(f.n);const a=f.v,command=String(a[0]).toUpperCase(),name=a.findIndex(x=>String(x).toUpperCase()==='SETNAME');if(name>=0)c.name=a[name+1]
   const isEval=['EVAL','EVALSHA'].includes(command),commandKey=isEval?a[3]:['GET','SET','MGET','DEL','HGETALL','HGET','TYPE','EXISTS'].includes(command)?a[1]:null,route=commandKey===key||commandKey===key+':guard',mode=route&&isEval?a[3+Number(a[2])]:null,sync=route&&c.name?.startsWith('zenith-route-sync:')
   const event={at:new Date().toISOString(),connection:c.id,name:c.name,command,key:commandKey,mode,route,sync};events.push(event);if(events.length>50000)throw new Error('Bounded evidence buffer exceeded')
   peakRouteConnections=Math.max(peakRouteConnections,[...connections].filter(x=>x.name?.startsWith('zenith-route-')).length)
   const captured=sync&&mode==='read'&&gate&&!gate.captured?gate:null;if(captured)captured.captured=true
   const hold=!!captured||(route&&mode==='write'&&dropWrite)||(route&&mode==='read'&&holdReads);if(route&&mode==='write'&&dropWrite)dropWrite=false
   c.pending.push({event,hold,captured});upstream.write(bytes)
  }})
  upstream.on('data',chunk=>{c.output=Buffer.concat([c.output,chunk]);let f;while((f=frame(c.output))){
   const bytes=c.output.subarray(0,f.n);c.output=c.output.subarray(f.n);const p=c.pending.shift()
   if(p){p.event.repliedAt=new Date().toISOString();if(p.event.route)p.event.reply=f.v}
   let released=false;const release=()=>{if(released)return;released=true;if(!c.closed){if(p)p.event.releasedAt=new Date().toISOString();client.write(bytes)}else if(p)p.event.closedBeforeRelease=true}
   if(p?.hold){c.held.push({event:p.event,release});if(p.captured){p.captured.release=release;p.captured.resolve(p.event)}}else release()
  }})
 })
 await new Promise(r=>server.listen(0,'127.0.0.1',r))
 return {port:server.address().port,events,get peakRouteConnections(){return peakRouteConnections},get routeConnections(){return [...connections].filter(c=>c.name?.startsWith('zenith-route-')).length},get held(){return [...connections].flatMap(c=>c.held.filter(x=>!x.event.releasedAt).map(x=>x.event))},
  holdNextSync(){if(gate)throw new Error('Sync gate already exists');let resolve;const reached=new Promise(r=>resolve=r),g={captured:false,resolve};gate=g;return {reached,release(){g.release?.();if(gate===g)gate=null}}},
  dropNextWriteReply(){dropWrite=true},set holdReads(v){holdReads=v},
  release(){gate=null;holdReads=false;dropWrite=false;for(const c of connections){const held=c.held;c.held=[];for(const h of held)h.release()}},
  cut(){partitioned=true;for(const c of [...connections]){c.client.destroy();c.upstream.destroy()}},recover(){partitioned=false},
  async close(){partitioned=true;for(const c of [...connections]){c.client.destroy();c.upstream.destroy()}await new Promise(r=>server.close(r))}}
}
