// One fixed HAProxy origin. The generator cannot select an instance or send directly to a gateway.
import http from 'node:http'
import {readFileSync,createWriteStream} from 'node:fs'
import {stabilityLoad} from '../benchmarks/stability-load.mjs'
const token=readFileSync('/secrets/zenith.admin.token','utf8').trim(),jobs=new Map(),entry='http://balancer:8080'
let active=false
http.createServer(async(req,res)=>{
 try{
  if(req.headers.authorization!=='Bearer '+token){res.writeHead(401).end();return}
  const path=new URL(req.url,'http://driver').pathname
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
