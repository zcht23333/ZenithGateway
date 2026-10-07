import net from 'node:net'
function frame(b,o=0){
 const e=b.indexOf('\r\n',o);if(e<0)return null;const t=String.fromCharCode(b[o]),s=b.toString('utf8',o+1,e);let n=e+2,v=s
 if(['$','!','='].includes(t)){const l=Number(s);if(l<0)return {n,v:null,t};if(b.length<n+l+2)return null;v=b.toString('utf8',n,n+l);n+=l+2}
 else if(['*','%','~','>','|'].includes(t)){v=[];for(let i=0;i<Number(s)*(t==='%'||t==='|'?2:1);i++){const x=frame(b,n);if(!x)return null;v.push(x.v);n=x.n}}
 else if(t===':')v=Number(s)
 return {n,v,t}
}
// Faults target real RESP command/reply boundaries. Captures have an explicit memory bound.
export async function limiterProxy(port,namespace,configKey){
 const connections=new Set(),events=[];let seq=0,mode='normal',blockSync=false,once=false,peakPending=0
 const server=net.createServer(client=>{
  const upstream=net.connect({host:'127.0.0.1',port}),c={id:++seq,client,upstream,name:null,input:Buffer.alloc(0),output:Buffer.alloc(0),pending:[],held:[],closed:false};connections.add(c)
  const close=()=>{if(c.closed)return;c.closed=true;for(const h of c.held)h.event.discardedOnClose=true;c.held=[];client.destroy();upstream.destroy();connections.delete(c)}
  for(const socket of [client,upstream]){socket.on('error',close);socket.on('close',close)}
  client.on('data',chunk=>{c.input=Buffer.concat([c.input,chunk]);let f;while((f=frame(c.input))){
   const bytes=c.input.subarray(0,f.n);c.input=c.input.subarray(f.n);const a=f.v,command=String(a[0]).toUpperCase(),index=a.findIndex(x=>String(x).toUpperCase()==='SETNAME');if(index>=0)c.name=a[index+1]
   const isEval=['EVAL','EVALSHA'].includes(command),limiter=isEval&&(String(a[3])===namespace+':policy'||String(a[3]).startsWith('zg:rl:tb:')),
    probe=(command==='PING'||(isEval&&Number(a[2])===0))&&c.name?.startsWith('zenith-rate-limit:'),sync=isEval&&a[3]===configKey&&a[4]==='read'&&c.name?.startsWith('zenith-runtime-sync:')
   const event={at:new Date().toISOString(),connection:c.id,name:c.name,command,key:isEval?a[3]:null,keys:isEval?a.slice(3,3+Number(a[2])):[],arguments:limiter?a.slice(3+Number(a[2])):undefined,limiter,probe,sync,forwarded:false};events.push(event);if(events.length>50000)throw new Error('Fault evidence bound exceeded')
   const fault=(limiter||probe)?mode:'normal',p={event,replyHeld:fault==='hold-reply'||fault==='drop-reply'||(sync&&blockSync)}
   if(fault==='disconnect'){event.disconnected=true;close();continue}
   const send=()=>{if(c.closed){event.discardedOnClose=true;return}event.forwarded=true;c.pending.push(p);upstream.write(bytes);peakPending=Math.max(peakPending,[...connections].reduce((n,x)=>n+x.pending.filter(y=>y.event.limiter).length+x.held.filter(y=>y.event.limiter&&!y.event.forwarded).length,0))}
   if(fault==='hold-request')c.held.push({event,release:send});else send()
   if(once&&limiter){mode='normal';once=false}
  }})
  upstream.on('data',chunk=>{c.output=Buffer.concat([c.output,chunk]);let f;while((f=frame(c.output))){
   const bytes=c.output.subarray(0,f.n);c.output=c.output.subarray(f.n);const p=c.pending.shift();if(p){p.event.repliedAt=new Date().toISOString();if(p.event.limiter)p.event.reply=f.v}
   if(p?.replyHeld)c.held.push({event:p.event,release:()=>{if(!c.closed)client.write(bytes);else p.event.discardedOnClose=true}});else client.write(bytes)
  }})
 })
 await new Promise(r=>server.listen(0,'127.0.0.1',r))
 return {port:server.address().port,events,setMode(value,{one=false}={}){mode=value;once=one},set blockSync(v){blockSync=v},
 get activeConnections(){return connections.size},get peakPending(){return peakPending},
 get held(){return [...connections].flatMap(c=>c.held.map(h=>h.event))},
 release(){const at=new Date().toISOString();mode='normal';blockSync=false;for(const c of connections){const list=c.held;c.held=[];for(const h of list)h.release()}return at},
 async close(){for(const c of connections){c.client.destroy();c.upstream.destroy()}await new Promise(r=>server.close(r))}}
}
