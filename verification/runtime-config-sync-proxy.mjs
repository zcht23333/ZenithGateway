import net from 'node:net'

function frame(buffer, offset=0) {
 const end=buffer.indexOf('\r\n',offset);if(end<0)return null
 const type=String.fromCharCode(buffer[offset]),line=buffer.toString('utf8',offset+1,end)
 let next=end+2,value=line
 if(['$','!','='].includes(type)){
  const length=Number(line);if(length<0)return {next,value:null,type}
  if(buffer.length<next+length+2)return null
  value=buffer.toString('utf8',next,next+length);next+=length+2
 }else if(['*','%','~','>','|'].includes(type)){
  const count=Number(line)*(type==='%'||type==='|'?2:1);value=[]
  for(let i=0;i<count;i++){const child=frame(buffer,next);if(!child)return null;value.push(child.value);next=child.next}
 }else if(type===':')value=Number(line)
 else if(!['+','-','_',',','#','('].includes(type))throw new Error('Unsupported RESP frame '+type)
 return {next,value,type}
}

// Only B uses this proxy. Boundaries are real RESP command/reply frames, not sleeps.
export async function syncProxy(redisPort,key){
 const connections=new Set(),events=[]
 let partitioned=false,hold=null,sequence=0,peakConnections=0
 const server=net.createServer(client=>{
  if(partitioned){client.destroy();return}
  const upstream=net.connect({host:'127.0.0.1',port:redisPort})
  const c={id:++sequence,client,upstream,clientName:null,ready:false,requests:Buffer.alloc(0),responses:Buffer.alloc(0),pending:[]}
  connections.add(c);peakConnections=Math.max(peakConnections,connections.size)
  const close=()=>{client.destroy();upstream.destroy();connections.delete(c)}
  client.on('error',close);upstream.on('error',close);client.on('close',close);upstream.on('close',close)
  client.on('data',bytes=>{
   c.requests=Buffer.concat([c.requests,bytes])
   let parsed
   while((parsed=frame(c.requests))){
    const bytes=c.requests.subarray(0,parsed.next);c.requests=c.requests.subarray(parsed.next)
    const args=parsed.value,command=String(args[0]).toUpperCase()
    const name=args.findIndex(a=>String(a).toUpperCase()==='SETNAME')
    if(name>=0)c.clientName=args[name+1]
    const isConfig=['EVAL','EVALSHA'].includes(command)&&args[3]===key
    const event={at:new Date().toISOString(),connection:c.id,clientName:c.clientName,command,
     key:isConfig?key:undefined,mode:isConfig?args[4]:undefined}
    if(events.length>=50000)throw new Error('Verification event bound exceeded')
    events.push(event)
    const capture=isConfig&&args[4]==='read'&&c.clientName?.startsWith('zenith-runtime-sync:')&&hold&&!hold.captured
    const pending={hold:capture?hold:null,command}
    if(capture)hold.captured=true
    c.pending.push(pending);upstream.write(bytes)
   }
  })
  upstream.on('data',bytes=>{
   c.responses=Buffer.concat([c.responses,bytes])
   let parsed
   while((parsed=frame(c.responses))){
    const bytes=c.responses.subarray(0,parsed.next);c.responses=c.responses.subarray(parsed.next)
    const pending=c.pending.shift()
    if(pending?.command==='HELLO'&&parsed.type!=='-')c.ready=true
    if(pending?.hold){
     const h=pending.hold
     h.reply={at:new Date().toISOString(),connection:c.id,value:parsed.value}
     h.release=()=>{if(h.released)return;h.released=true;if(!client.destroyed)client.write(bytes);if(hold===h)hold=null}
     h.resolve(h.reply)
    }else client.write(bytes)
   }
  })
 })
 await new Promise(r=>server.listen(0,'127.0.0.1',r))
 return {
  port:server.address().port,events,
  get activeConnections(){return connections.size},
  get applicationConnected(){return [...connections].some(c=>c.ready&&!c.clientName&&!c.client.destroyed&&!c.upstream.destroyed)},
  get peakConnections(){return peakConnections},
  holdNextRead(){
   if(hold)throw new Error('A read is already held')
   let resolve;const reached=new Promise(r=>resolve=r)
   const h={resolve,captured:false};hold=h
   return {reached,release(){h.release?.();if(hold===h)hold=null}}
  },
  cut(){partitioned=true;for(const c of connections){c.client.destroy();c.upstream.destroy()}},
  recover(){partitioned=false},
  async close(){
   partitioned=true
   for(const c of connections){c.client.destroy();c.upstream.destroy()}
   await new Promise(r=>server.close(r))
  }
 }
}
