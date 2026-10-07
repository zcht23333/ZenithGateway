import net from 'node:net'

// Frame-aware fault injection. Holding a connection (rather than immediately closing it)
// avoids an implicit client replay while the test is observing the ambiguous outcome.
function frame(buffer, offset=0) {
 const end=buffer.indexOf('\r\n',offset)
 if(end<0)return null
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
export async function faultProxy(redisPort,key,writeModes=['write']) {
 const connections=new Set(),events=[]
 let fault=null
 const server=net.createServer(client=>{
  const upstream=net.connect({host:'127.0.0.1',port:redisPort})
  const connection={client,upstream,requests:Buffer.alloc(0),responses:Buffer.alloc(0),pending:[],blocked:false}
  connections.add(connection)
  const close=()=>{client.destroy();upstream.destroy();connections.delete(connection)}
  client.on('error',close);upstream.on('error',close);client.on('close',close);upstream.on('close',close)
  client.on('data',data=>{
   connection.requests=Buffer.concat([connection.requests,data])
   let parsed
   while((parsed=frame(connection.requests))){
    const bytes=connection.requests.subarray(0,parsed.next);connection.requests=connection.requests.subarray(parsed.next)
    const args=parsed.value
    const script=Array.isArray(args)&&['EVAL','EVALSHA'].includes(String(args[0]).toUpperCase())&&args[3]===key
    const hit=script&&writeModes.includes(args[4])&&fault&&!fault.captured
    events.push({command:args[0],key:script?key:undefined,mode:script?args[4]:undefined})
    if(hit){
     fault.captured=true;fault.connection=connection;fault.command=args
     if(fault.phase==='before'){
      connection.blocked=true;fault.observed({phase:'before',forwarded:false,expectedVersion:args[5]});continue
     }
    }
    if(connection.blocked)continue
    connection.pending.push({fault:hit?fault:null})
    upstream.write(bytes)
   }
  })
  upstream.on('data',data=>{
   connection.responses=Buffer.concat([connection.responses,data])
   let parsed
   while((parsed=frame(connection.responses))){
    const bytes=connection.responses.subarray(0,parsed.next);connection.responses=connection.responses.subarray(parsed.next)
    // No pub/sub or client tracking is enabled; HELLO's RESP3 map is one command reply.
    const pending=connection.pending.shift()
    if(pending?.fault){
     connection.blocked=true
     pending.fault.observed({phase:'after',forwarded:true,redisReply:parsed.value,expectedVersion:pending.fault.command[5]})
    }
    if(!connection.blocked)client.write(bytes)
   }
  })
 })
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 return {
  port:server.address().port,events,
  arm(phase){
   if(fault)throw new Error('A fault is already armed')
   let observed
   const reached=new Promise(resolve=>{observed=resolve})
   fault={phase,observed,captured:false}
   return reached
  },
  recover(){
   if(fault?.connection){fault.connection.client.destroy();fault.connection.upstream.destroy()}
   fault=null
  },
  async close(){
   for(const c of connections){c.client.destroy();c.upstream.destroy()}
   await new Promise(resolve=>server.close(resolve))
  }
 }
}
