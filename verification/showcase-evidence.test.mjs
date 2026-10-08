import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {gzipSync} from 'node:zlib'
import {verifyEvidence} from './showcase-evidence.mjs'
const hash=b=>createHash('sha256').update(b).digest('hex')
async function fixture(run){
 const dir=await mkdtemp(join(tmpdir(),'zg-public-evidence-')),raw=Buffer.from('original raw record\n'),packed=gzipSync(raw)
 const row={file:'raw.gz',format:'gzip',bytes:packed.length,sha256:hash(packed),extractAs:'case/raw.txt',uncompressedBytes:raw.length,uncompressedSha256:hash(raw)},manifest=join(dir,'manifest.json')
 const save=rows=>writeFile(manifest,JSON.stringify({schemaVersion:1,files:rows}))
 try{await writeFile(join(dir,'raw.gz'),packed);await save([row]);await run({dir,raw,packed,row,manifest,save})}finally{await rm(dir,{recursive:true,force:true})}
}
test('portable evidence verifies original bytes and refuses to overwrite an extraction',()=>fixture(async({dir,raw,manifest})=>{
 const out=join(dir,'new'),r=await verifyEvidence(manifest,{extractTo:out});assert.equal(r.files,1);assert.equal(r.extracted,1);assert.deepEqual(await readFile(join(out,'case/raw.txt')),raw)
 await assert.rejects(verifyEvidence(manifest,{extractTo:out}),/EEXIST/)
}))
test('corrupt storage and false original digests fail independently',()=>fixture(async({dir,packed,row,manifest,save})=>{
 await save([{...row,sha256:'0'.repeat(64)}]);await assert.rejects(verifyEvidence(manifest),/Stored digest mismatch/)
 await save([{...row,uncompressedSha256:'0'.repeat(64)}]);await assert.rejects(verifyEvidence(manifest),/Expanded digest mismatch/)
}))
test('traversal, Windows absolute paths and duplicate targets are rejected before extraction',()=>fixture(async({dir,row,manifest,save})=>{
 for(const extractAs of ['../escape','C:/escape','\\\\server\\share','/absolute']){await save([{...row,extractAs}]);await assert.rejects(verifyEvidence(manifest),/Unsafe/)}
 await save([row,{...row,file:'second.gz'}]);await assert.rejects(verifyEvidence(manifest),/Duplicate extraction/)
}))
test('declared expansion bounds and decoded length mismatches fail',()=>fixture(async({dir,row,manifest,save})=>{
 await save([{...row,uncompressedBytes:100*1024*1024}]);await assert.rejects(verifyEvidence(manifest),/exceeds bound/)
 await save([{...row,uncompressedBytes:1}]);await assert.rejects(verifyEvidence(manifest),/Expanded size mismatch/)
}))
