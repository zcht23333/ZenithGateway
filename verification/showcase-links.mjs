// Validate the public reading path; archived reports can still contain provenance-only local paths.
import assert from 'node:assert/strict'
import {readFile,stat} from 'node:fs/promises'
import {resolve,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
const root=fileURLToPath(new URL('..',import.meta.url)),files=['README.md','docs/backend-case-studies.md','docs/evidence-index.md','docs/product-showcase.md','docs/showcase-release.md','docs/showcase-proxy-reset-fix.md','docs/showcase-validation-fixes.md','docs/interview-guide.md','docs/interview-demo.md','docs/interview-questions.md','docs/main-upgrade-20261008.md']
let checked=0
for(const file of files){
 const content=await readFile(resolve(root,file),'utf8')
 for(const match of content.matchAll(/\]\(([^)]+)\)/g)){
  const target=match[1]
  if(/^https?:\/\//.test(target)||target.startsWith('#'))continue
  assert(!/^[a-z]:|^file:|(?:^|\/)\.dev\//i.test(target),'Public entry depends on a workstation path: '+file+' '+target)
  const path=resolve(root,dirname(file),decodeURIComponent(target.split('#')[0]))
  assert(await stat(path).catch(()=>null),'Missing public entry target: '+file+' '+target);checked++
 }
}
console.log(JSON.stringify({passed:true,documents:files.length,localTargetsChecked:checked}))
