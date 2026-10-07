// Linux fixed-arrival driver service. Test-only; shares no production state or routing control.
import http from 'node:http'
import {readFileSync,createWriteStream} from 'node:fs'
import {stabilityLoad} from '../benchmarks/stability-load.mjs'
const token=readFileSync('/secrets/zenith.admin.token','utf8').trim(),jobs=new Map()
let active=0
http.createServer(async(req,res)=>{
 if(req.headers.authorization!=='Bearer '+token){res.writeHead(401).end();return}
 try{
  const path=new URL(req.url,'http://driver').pathname
  if(req.method==='POST'&&path==='/start'){
   let text='';for await(const chunk of req){text+=chunk;if(text.length>4096)throw new Error('Input limit')}
   const v=JSON.parse(text);if(!/^[a-zA-Z0-9-]{1,80}$/.test(v.id)||jobs.has(v.id)||active>=2||v.durationSeconds>60||v.arrivalRate>2000)throw new Error('Invalid/busy job')
   if(jobs.size>=128){const oldest=[...jobs].find(([,j])=>j.state!=='running');if(oldest)jobs.delete(oldest[0]);else throw new Error('Job bound')}
   const job={id:v.id,state:'running',startedAt:new Date().toISOString()};jobs.set(v.id,job);active++
   const stream=createWriteStream('/evidence/'+v.id+'-responses.jsonl')
   void stabilityLoad({...v,onResult:row=>{if(stream.writableLength>4*1024*1024)throw new Error('Evidence writer bound');stream.write(JSON.stringify(row)+'\n')}})
    .then(result=>{job.result=result;job.state='complete'},error=>{job.error=error.stack;job.state='failed'})
    .finally(()=>{active--;stream.end()})
   res.writeHead(202,{'Content-Type':'application/json'}).end(JSON.stringify(job));return
  }
  const job=jobs.get(path.substring(1));res.setHeader('Content-Type','application/json');res.end(JSON.stringify(job||{ready:true,active}))
 }catch(e){res.writeHead(400).end(JSON.stringify({error:e.message}))}
}).listen(8091,'0.0.0.0')
