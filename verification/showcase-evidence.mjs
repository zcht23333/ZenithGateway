import assert from 'node:assert/strict'
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises'
import {resolve,dirname,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {gunzipSync} from 'node:zlib'

const maxFileBytes=96*1024*1024,maxTotalBytes=256*1024*1024
const digest=bytes=>createHash('sha256').update(bytes).digest('hex')
function safeMember(name){
 assert(typeof name==='string'&&/^[A-Za-z0-9._/-]+$/.test(name)&&!name.startsWith('/')&&!name.split('/').some(x=>!x||x==='.'||x==='..'),'Unsafe evidence member path')
 return name
}
export async function verifyEvidence(manifestPath,{extractTo}={}){
 const source=resolve(manifestPath),root=dirname(source),manifest=JSON.parse(await readFile(source,'utf8'))
 assert.equal(manifest.schemaVersion,1);assert(Array.isArray(manifest.files)&&manifest.files.length>0&&manifest.files.length<=512,'Invalid evidence member count')
 const names=new Set(),outputs=new Set();let declaredBytes=0
 for(const row of manifest.files){
  safeMember(row.file);assert(!names.has(row.file),'Duplicate evidence member');names.add(row.file)
  assert(['json','gzip'].includes(row.format));assert(Number.isSafeInteger(row.bytes)&&row.bytes>=0&&row.bytes<=maxFileBytes,'Evidence size exceeds bound')
  assert(/^[a-f0-9]{64}$/.test(row.sha256),'Missing evidence digest')
  if(row.format==='gzip'){
   safeMember(row.extractAs);assert(!outputs.has(row.extractAs),'Duplicate extraction target');outputs.add(row.extractAs)
   assert(Number.isSafeInteger(row.uncompressedBytes)&&row.uncompressedBytes>=0&&row.uncompressedBytes<=maxFileBytes,'Expanded evidence exceeds bound')
   assert(/^[a-f0-9]{64}$/.test(row.uncompressedSha256),'Missing expanded digest');declaredBytes+=row.uncompressedBytes
  }else declaredBytes+=row.bytes
 }
 assert(declaredBytes<=maxTotalBytes,'Total expanded evidence exceeds bound')
 const out=extractTo?resolve(extractTo):null
 if(out){assert(out!==root&&!root.startsWith(out+'/')&&!root.startsWith(out+'\\'),'Extraction must not replace the evidence root');await mkdir(dirname(out),{recursive:true});await mkdir(out)}
 let storedBytes=0,expandedBytes=0,extracted=0
 for(const row of manifest.files){
  const file=join(root,row.file);assert.equal((await stat(file)).size,row.bytes,'Stored size mismatch: '+row.file)
  const packed=await readFile(file);assert.equal(packed.length,row.bytes,'Stored size mismatch: '+row.file);assert.equal(digest(packed),row.sha256,'Stored digest mismatch: '+row.file)
  storedBytes+=packed.length
  if(row.format==='gzip'){
   const raw=gunzipSync(packed,{maxOutputLength:maxFileBytes});assert.equal(raw.length,row.uncompressedBytes,'Expanded size mismatch');assert.equal(digest(raw),row.uncompressedSha256,'Expanded digest mismatch')
   expandedBytes+=raw.length
   if(out){const target=join(out,row.extractAs);await mkdir(dirname(target),{recursive:true});await writeFile(target,raw,{flag:'wx'});extracted++}
  }else expandedBytes+=packed.length
 }
 return {passed:true,files:manifest.files.length,storedBytes,expandedBytes,extracted,testedJarSha256:manifest.testedJarSha256,extraction:out,
  note:'Integrity and historical evidence only; no new capacity run. Extraction output must be new; partial output is retained on error.'}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 let manifest=fileURLToPath(new URL('../docs/evidence/showcase-20261008/manifest.json',import.meta.url)),extractTo
 const args=process.argv.slice(2)
 for(let n=0;n<args.length;n++)if(args[n]==='--extract')extractTo=args[++n];else if(args[n]==='--manifest')manifest=args[++n];else throw Error('Usage: node verification/showcase-evidence.mjs [--manifest file] [--extract NEW-directory]')
 console.log(JSON.stringify(await verifyEvidence(manifest,{extractTo}),null,2))
}
