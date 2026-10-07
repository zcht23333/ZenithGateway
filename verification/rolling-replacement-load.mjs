// One fixed HAProxy origin. The generator cannot select an instance or send directly to a gateway.
import http from 'node:http'
import {readFileSync,createWriteStream} from 'node:fs'
import {stabilityLoad} from '../benchmarks/stability-load.mjs'
const token=readFileSync('/secrets/zenith.admin.token','utf8').trim(),jobs=new Map(),probes=new Map(),entry='http://balancer:8080'
let active=false
function probe(id){
 if(probes.size>=16||probes.has(id)||!/^[-a-zA-Z0-9]{1,80}$/.test(id))throw new Error('Invalid/duplicate probe')
 const path='/probe/hold/'+id,job={id,path,state:'running',status:0,body:'',client:'linux-driver'},started=performance.now();let finished=false,timer
 const finish=termination=>{if(finished)return;finished=true;clearTimeout(timer);job.state='complete';job.result={path,status:job.status,body:job.body,instance:job.instance,localPort:req.socket?.localPort,termination,elapsedMs:performance.now()-started,at:new Date().toISOString(),client:'linux-driver'}}
 const req=http.get(entry+path,res=>{job.status=res.statusCode;job.instance=res.headers['x-verification-instance'];res.on('data',b=>{job.body+=b;if(job.body.length>65536)req.destroy(new Error('Probe body bound'))});res.once('end',()=>finish('complete'));res.once('aborted',()=>finish('aborted'));res.once('error',()=>finish('response_error'))})
 req.once('error',e=>finish(e.code||'request_error'));timer=setTimeout(()=>{finish('client_deadline');req.destroy()},25000)
 probes.set(id,{job,cancel(mode){if(finished)throw new Error('Probe already ended');if(!req.socket)throw new Error('Probe not connected');if(!['fin','reset'].includes(mode))throw new Error('Bad cancel mode');job.cancelMode=mode;finish('client_cancelled');job.result.cancelMode=mode;if(mode==='reset')req.socket.resetAndDestroy();else req.destroy()}})
 return job
}
http.createServer(async(req,res)=>{
 try{
  if(req.headers.authorization!=='Bearer '+token){res.writeHead(401).end();return}
  const path=new URL(req.url,'http://driver').pathname
  if(req.method==='POST'&&path.startsWith('/probe')){
   let text='';for await(const b of req){text+=b;if(text.length>4096)throw new Error('Input bound')};const v=JSON.parse(text)
   if(path==='/probe-start'){res.writeHead(202,{'Content-Type':'application/json'}).end(JSON.stringify(probe(v.id)));return}
   if(path==='/probe-cancel'){const p=probes.get(v.id);if(!p)throw new Error('Unknown probe');p.cancel(v.mode);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(p.job));return}
   throw new Error('Unknown probe action')
  }
  if(req.method==='GET'&&path.startsWith('/probe/')){const p=probes.get(path.slice(7));if(!p)throw new Error('Unknown probe');res.setHeader('Content-Type','application/json');res.end(JSON.stringify(p.job));return}
  if(req.method==='POST'&&path==='/start'){
   let text='';for await(const b of req){text+=b;if(text.length>4096)throw new Error('Input bound')}
   const v=JSON.parse(text)
   if(active||jobs.size>=64||jobs.has(v.id)||!/^[-a-zA-Z0-9]{1,80}$/.test(v.id)||!Number.isInteger(v.rate)||v.rate<1||v.rate>100||!Number.isInteger(v.seconds)||v.seconds<1||v.seconds>30)throw new Error('Invalid/busy window')
   const job={id:v.id,state:'running',entry};jobs.set(v.id,job);active=true
   const file=createWriteStream('/evidence/'+v.id+'-ingress.jsonl',{flags:'wx'})
   void stabilityLoad({urls:Array.from({length:v.rate*v.seconds},(_,n)=>entry+'/probe/quick/'+v.id+'-'+n),arrivalRate:v.rate,durationSeconds:v.seconds,connections:64,timeoutMs:8000,
    onResult:row=>{if(file.writableLength>4*1024*1024)throw new Error('Evidence bound');file.write(JSON.stringify({...row,termination:row.status?'complete':row.code})+'\n')}})
    .then(result=>{job.result=result;job.state='complete'},e=>{job.error=e.stack;job.state='failed'})
    .finally(()=>{file.end();active=false})
   res.writeHead(202,{'Content-Type':'application/json'}).end(JSON.stringify(job));return
  }
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(jobs.get(path.slice(1))||{ready:true,active,entry}))
 }catch(e){res.writeHead(400).end(JSON.stringify({error:e.message}))}
}).listen(8091,'0.0.0.0')
