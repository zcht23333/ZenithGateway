import {after,before,test} from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'vite'
let server,model,createSettingsEditor,ApiError
const initial={rateLimitEnabled:true,replenishRate:20,burstCapacity:40,requestedTokens:1,monitorWindowSeconds:10,emitIntervalSeconds:1}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}}
before(async()=>{
 server=await createServer({configFile:false,optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:false,ws:false},appType:'custom'})
 model=await server.ssrLoadModule('/src/settings/model.ts')
 ;({createSettingsEditor}=await server.ssrLoadModule('/src/settings/editor.ts'))
 ;({ApiError}=await server.ssrLoadModule('/src/api.ts'))
})
after(async()=>{await server.close()})
const epoch='11111111-1111-1111-1111-111111111111'
function wire(values=initial,revision=1,confirmation='read',adoptedRevision=revision){
 const current={...model.parseConfig(values),version:epoch+':'+revision}
 return {...current,source:'redis',confirmation,adopted:{...current,version:epoch+':'+adoptedRevision}}
}
function receipt(request,after,before=wire(initial,Number(request.expectedVersion.slice(37)))) {
 return {operationId:request.operationId,expectedVersion:request.expectedVersion,request:model.parseConfig(request),
  before:model.parseSnapshot(before),after:model.parseSnapshot(after),status:'committed',recordedAt:1,expiresAt:86400001,instanceId:epoch}
}
function client(extra={}){
 const delegate={read:async()=>({...initial}),write:async v=>v,...extra}
 let revision=1,signature=JSON.stringify(initial)
 const normalize=(value,confirmation)=>{
  if(value?.version)return value
  let values;try{values=model.parseConfig(value)}catch{return value}
  const nextSignature=JSON.stringify(values)
  if(confirmation==='committed'||nextSignature!==signature)revision++
  signature=nextSignature
  return wire(values,revision,confirmation)
 }
 return {read:async signal=>normalize(await delegate.read(signal),'read'),write:async v=>{const result=normalize(await delegate.write(v),'committed');return {...result,receipt:receipt(v,result)}}}
}

test('all five numeric fields preserve invalid text and enforce their actual integer boundaries',()=>{
 for(const field of model.numericFields){
  for(const raw of ['', ' ', '1.2', 'abc', '-1', '0', '1e2', String(field.max+1)]){
   const draft=model.toDraft(initial);draft[field.key]=raw
   assert.ok(model.validateDraft(draft)[field.key],field.key+' '+raw)
   assert.equal(model.parseDraft(draft),null);assert.equal(draft[field.key],raw)
  }
  for(const raw of ['1',String(field.max)]){
   const draft=model.toDraft(initial);draft[field.key]=raw
   assert.equal(model.validateDraft(draft)[field.key],undefined)
   assert.equal(model.parseDraft(draft)[field.key],Number(raw))
  }
 }
 assert.throws(()=>model.parseConfig({rateLimitEnabled:false}))
 assert.throws(()=>model.parseConfig({...initial,emitIntervalSeconds:0}))
})
test('initial loading and read failure never create editable defaults or submit an unknown baseline',async()=>{
 let writes=0;const waiting=deferred()
 const editor=createSettingsEditor(client({read:()=>waiting.promise,write:async v=>{writes++;return v}}))
 const pending=editor.load();assert.equal(editor.state.loading,true)
 assert.equal(editor.state.current,null);assert.equal(editor.state.draft.replenishRate,'')
 editor.edit('replenishRate','50');await editor.save();assert.equal(writes,0)
 waiting.reject(new Error('unavailable'));await pending
 assert.equal(editor.state.current,null);assert.equal(editor.canSave.value,false);assert.match(editor.state.readError,/unavailable/)
})
test('only actual differences are submitted; restoring values does not write',async()=>{
 let writes=0
 const editor=createSettingsEditor(client({write:async v=>{writes++;return v}}));await editor.load()
 editor.edit('replenishRate','020');assert.equal(editor.dirty.value,false)
 editor.edit('rateLimitEnabled',false);editor.edit('requestedTokens','2')
 assert.deepEqual(editor.changes.value,['rateLimitEnabled','requestedTokens'])
 editor.restore();assert.equal(editor.dirty.value,false);await editor.save();assert.equal(writes,0)
})
test('invalid drafts and unchanged forms cannot trigger PUT',async()=>{
 let writes=0
 const editor=createSettingsEditor(client({write:async v=>{writes++;return v}}));await editor.load()
 editor.edit('monitorWindowSeconds','121');await editor.save();assert.equal(writes,0)
 assert.equal(editor.state.draft.monitorWindowSeconds,'121')
 editor.edit('monitorWindowSeconds','120');assert.equal(editor.canSave.value,true)
})
test('one pending save locks edits, restore, read and repeated submission',async()=>{
 let writes=0,reads=0;const waiting=deferred()
 const editor=createSettingsEditor(client({read:async()=>{reads++;return initial},write:()=>{writes++;return waiting.promise}}))
 await editor.load();editor.edit('replenishRate','40');const pending=editor.save()
 await editor.save();await editor.load();editor.edit('replenishRate','80');editor.restore()
 assert.equal(writes,1);assert.equal(reads,1);assert.equal(editor.state.draft.replenishRate,'40')
 waiting.resolve({...initial,replenishRate:40});await pending;assert.equal(editor.state.saving,false)
})
test('a mismatched success payload cannot manufacture a valid receipt',async()=>{
 let reads=0
 const editor=createSettingsEditor(client({read:async()=>{reads++;return initial},write:async()=>({...initial,replenishRate:35})}))
 await editor.load();editor.edit('replenishRate','40');await editor.save()
 assert.equal(reads,1);assert.equal(editor.state.current.replenishRate,20);assert.equal(editor.state.draft.replenishRate,'40')
 assert.equal(editor.state.writeStatus,'uncertain');assert.equal(editor.dirty.value,true)
 assert.equal(editor.state.operationStatus,'unknown')
})
test('explicit rejection preserves the draft, baseline and field error until edited',async()=>{
 const editor=createSettingsEditor(client({write:async()=>{throw new ApiError('字段无效',422,'replenishRate')}}))
 await editor.load();editor.edit('replenishRate','40');await editor.save()
 assert.equal(editor.state.current.replenishRate,20);assert.equal(editor.state.draft.replenishRate,'40')
 assert.equal(editor.state.writeStatus,'rejected');assert.equal(editor.state.needsConfirmation,false)
 assert.equal(editor.errors.value.replenishRate,'字段无效')
 editor.edit('replenishRate','41');assert.equal(editor.canSave.value,true)
})
test('network errors, server errors and malformed success bodies require reconciliation before another write',async()=>{
 for(const failure of [new Error('timeout'),new ApiError('upstream failure',503),null]){
  let writes=0
  const editor=createSettingsEditor(client({write:async()=>{writes++;if(failure)throw failure;return {}}}))
  await editor.load();editor.edit('replenishRate','40');await editor.save();await editor.save()
  assert.equal(writes,1);assert.equal(editor.state.writeStatus,'uncertain');assert.equal(editor.state.needsConfirmation,true)
  editor.restore();assert.equal(editor.state.draft.replenishRate,'40');assert.equal(editor.canSave.value,false)
 }
})
test('matching current values never resolve the unknown original operation',async()=>{
 let saved={...initial},writes=0
 const editor=createSettingsEditor(client({read:async()=>saved,write:async v=>{writes++;saved=v;throw new Error('lost response')}}))
 await editor.load();editor.edit('replenishRate','40');await editor.save();await editor.load()
 assert.equal(editor.state.writeStatus,'uncertain');assert.equal(editor.dirty.value,false);assert.equal(writes,1)
 assert.match(editor.state.writeMessage,/不能证明原提交/);assert.equal(editor.state.savedAt,null);assert.equal(editor.state.needsConfirmation,true)
})
test('read confirmation that differs preserves intended edits and permits an explicit retry',async()=>{
 const editor=createSettingsEditor(client({write:async()=>{throw new Error('lost response')}}))
 await editor.load();editor.edit('replenishRate','40');await editor.save();await editor.load()
 assert.equal(editor.state.current.replenishRate,20);assert.equal(editor.state.draft.replenishRate,'40')
 assert.equal(editor.state.needsConfirmation,true);assert.equal(editor.canSave.value,false)
 editor.acknowledgeReview();assert.equal(editor.canSave.value,false)
 editor.finishUnknown();editor.acknowledgeReview();assert.equal(editor.canSave.value,true)
})
test('refresh preserves edited fields but updates untouched fields, avoiding a blind stale overwrite',async()=>{
 let remote={...initial}
 const editor=createSettingsEditor(client({read:async()=>remote}))
 await editor.load();editor.edit('replenishRate','40');remote={...initial,replenishRate:30,burstCapacity:60}
 await editor.load();assert.equal(editor.state.current.replenishRate,30);assert.equal(editor.state.draft.replenishRate,'40')
 assert.equal(editor.state.draft.burstCapacity,'60');assert.deepEqual(editor.changes.value,['replenishRate'])
})
test('confirmed save remains confirmed when a later read fails, and retry recovers separately',async()=>{
 let unavailable=false,saved={...initial}
 const editor=createSettingsEditor(client({read:async()=>{if(unavailable)throw new Error('read failed');return saved},write:async v=>(saved=v)}))
 await editor.load();editor.edit('replenishRate','40');await editor.save();const time=editor.state.savedAt
 unavailable=true;await editor.load()
 assert.equal(editor.state.writeStatus,'confirmed');assert.equal(editor.state.current.replenishRate,40);assert.equal(editor.state.savedAt,time)
 assert.match(editor.state.readError,/read failed/)
 unavailable=false;await editor.load();assert.equal(editor.state.readError,'');assert.equal(editor.state.savedAt,time)
})
test('authentication rejection retains the unsaved draft until a fresh authenticated read',async()=>{
 const editor=createSettingsEditor(client({write:async()=>{throw new ApiError('请重新连接',401)}}))
 await editor.load();editor.edit('burstCapacity','80');await editor.save()
 assert.equal(editor.state.authExpired,true);assert.equal(editor.state.draft.burstCapacity,'80');assert.equal(editor.canSave.value,false)
 await editor.load();assert.equal(editor.state.authExpired,false);assert.equal(editor.state.draft.burstCapacity,'80')
})
test('unmounted reads cannot replace the current editor and a fresh read still succeeds',async()=>{
 const waiting=deferred();let first=true
 const editor=createSettingsEditor(client({read:()=>first?waiting.promise:Promise.resolve(initial)}))
 const pending=editor.load();editor.cancelRead();first=false;await editor.load()
 waiting.resolve({...initial,replenishRate:99});await pending
 assert.equal(editor.state.current.replenishRate,20);assert.equal(editor.state.loading,false)
})

test('conflict keeps only edited fields, displays remote differences, and requires manual review before a new CAS',async()=>{
 const requests=[];let revision=1,remote={...initial}
 const editor=createSettingsEditor({
  read:async()=>wire(remote,revision),
  write:async request=>{
   requests.push(request)
   if(request.expectedVersion!==epoch+':'+revision)
    throw new ApiError('conflict',409,undefined,{code:'CONFIG_VERSION_CONFLICT',outcome:'not-written',current:wire(remote,revision),adopted:wire(remote,revision)})
   const before=wire(remote,revision);remote=model.parseConfig(request);revision++;const after=wire(remote,revision,'committed');return {...after,receipt:receipt(request,after,before)}
  }
 })
 await editor.load();editor.edit('replenishRate','40')
 remote.monitorWindowSeconds=30;revision=2 // A saved first; B still holds v1.
 await editor.save()
 assert.equal(requests[0].expectedVersion,epoch+':1')
 assert.equal(editor.state.writeStatus,'conflict');assert.equal(editor.state.draft.replenishRate,'40')
 assert.equal(editor.state.draft.monitorWindowSeconds,'30');assert.equal(editor.state.current.version,epoch+':2')
 assert.deepEqual(editor.state.remoteChanges,[{key:'monitorWindowSeconds',before:10,latest:30}])
 await editor.save();assert.equal(requests.length,1)
 editor.acknowledgeReview();await editor.save()
 assert.equal(requests[1].expectedVersion,epoch+':2');assert.equal(requests[1].monitorWindowSeconds,30)
 assert.equal(editor.state.current.version,epoch+':3');assert.equal(editor.state.writeStatus,'confirmed')
})
test('another conflict after manual review again protects the draft and requires review',async()=>{
 let revision=1,rate=20
 const editor=createSettingsEditor({read:async()=>wire(initial),write:async()=>{
  revision++;rate+=5
  throw new ApiError('conflict',409,undefined,{code:'CONFIG_VERSION_CONFLICT',outcome:'not-written',
   current:wire({...initial,replenishRate:rate},revision),adopted:wire({...initial,replenishRate:rate},revision)})
 }})
 await editor.load();editor.edit('replenishRate','40');await editor.save();editor.acknowledgeReview();await editor.save()
 assert.equal(editor.state.reviewRequired,true);assert.equal(editor.state.draft.replenishRate,'40')
 assert.equal(editor.state.current.replenishRate,30);assert.equal(editor.canSave.value,false)
})
test('known storage rejection and acknowledged-but-unadopted writes have distinct outcomes',async()=>{
 for(const outcome of ['not-written','committed']){
  const editor=createSettingsEditor(client({write:async()=>{throw new ApiError('storage issue',503,undefined,{outcome})}}))
  await editor.load();editor.edit('replenishRate','40');await editor.save()
  assert.equal(editor.state.draft.replenishRate,'40')
  assert.equal(editor.state.writeStatus,outcome==='committed'?'committed-unadopted':'rejected')
  assert.equal(editor.state.needsConfirmation,outcome==='committed')
 }
})
test('unavailable confirmation stays unknown; another update cannot prove the original request never executed',async()=>{
 let reads=0
 const editor=createSettingsEditor({
  read:async()=>{reads++;if(reads===2)throw new ApiError('Redis unavailable',503);return wire({...initial,monitorWindowSeconds:reads===1?10:30},reads===1?1:3)},
  write:async()=>{throw new Error('Redis acknowledgement lost')}
 })
 await editor.load();editor.edit('replenishRate','40');await editor.save();await editor.load()
 assert.equal(editor.state.needsConfirmation,true);assert.equal(editor.state.current.version,epoch+':1')
 await editor.load()
 assert.equal(editor.state.current.version,epoch+':3');assert.equal(editor.state.draft.monitorWindowSeconds,'30')
 assert.equal(editor.state.draft.replenishRate,'40');assert.equal(editor.state.reviewRequired,true)
 assert.match(editor.state.writeMessage,/不能证明原提交是否执行/)
})
test('missing versions cannot form a baseline and unrelated successful response versions require confirmation',async()=>{
 const legacy=createSettingsEditor({read:async()=>initial,write:async()=>{throw new Error('must not write')}})
 await legacy.load();assert.equal(legacy.state.current,null);assert.match(legacy.state.readError,/版本缺失/)
 const editor=createSettingsEditor({read:async()=>wire(initial),write:async()=>wire(initial,7,'committed')})
 await editor.load();editor.edit('replenishRate','40');await editor.save()
 assert.equal(editor.state.writeStatus,'uncertain');assert.equal(editor.state.draft.replenishRate,'40')
})
test('an older storage read with a newer local adoption cannot enable writes',async()=>{
 const editor=createSettingsEditor({read:async()=>wire(initial,2,'read',3),write:async()=>{throw new Error('must not write')}})
 await editor.load();editor.edit('replenishRate','40')
 assert.equal(editor.state.needsConfirmation,true);assert.equal(editor.canSave.value,false)
 assert.equal(editor.state.current.version,epoch+':2');assert.equal(editor.state.adopted.version,epoch+':3')
})
test('authentication recovery after conflict retains edits and still demands explicit review',async()=>{
 let unauthorized=false,conflicted=false
 const editor=createSettingsEditor({read:async()=>{if(unauthorized)throw new ApiError('expired',401);return wire({...initial,monitorWindowSeconds:conflicted?40:30},conflicted?3:2)},
 write:async()=>{conflicted=true;throw new ApiError('conflict',409,undefined,{code:'CONFIG_VERSION_CONFLICT',current:wire({...initial,monitorWindowSeconds:40},3),adopted:wire({...initial,monitorWindowSeconds:40},3)})}})
 await editor.load();editor.edit('replenishRate','40');await editor.save()
 unauthorized=true;await editor.load();assert.equal(editor.state.authExpired,true)
 unauthorized=false;await editor.load()
 assert.equal(editor.state.draft.replenishRate,'40');assert.equal(editor.state.authExpired,false)
 assert.equal(editor.state.reviewRequired,true);assert.equal(editor.canSave.value,false)
})

test('an incomplete conflict response proves rejection but cannot enable another write before reading',async()=>{
 const editor=createSettingsEditor(client({write:async()=>{throw new ApiError('conflict',409,undefined,{code:'CONFIG_VERSION_CONFLICT',outcome:'not-written',current:{version:'bad'}})}}))
 await editor.load();editor.edit('replenishRate','40');await editor.save()
 assert.equal(editor.state.writeStatus,'conflict');assert.equal(editor.state.needsConfirmation,true)
 assert.equal(editor.state.draft.replenishRate,'40');assert.equal(editor.canSave.value,false)
 assert.match(editor.state.writeMessage,/本次未写入.*响应不完整/)
})

test('a known committed write remains known after local adoption recovers, instead of becoming historically unknown',async()=>{
 let remote=wire(initial)
 const editor=createSettingsEditor({read:async()=>remote,write:async()=>{
  remote=wire({...initial,replenishRate:40},2)
  throw new ApiError('adoption failed',503,undefined,{code:'CONFIG_ADOPTION_FAILED',outcome:'committed',confirmed:remote,adopted:wire(initial)})
 }})
 await editor.load();editor.edit('replenishRate','40');await editor.save()
 assert.equal(editor.state.writeStatus,'committed-unadopted');assert.equal(editor.state.needsConfirmation,true)
 assert.equal(editor.state.current.version,epoch+':2');assert.equal(editor.state.adopted.version,epoch+':1')
 await editor.load();assert.equal(editor.state.needsConfirmation,false)
 assert.match(editor.state.writeMessage,/此前存储写入已确认/);assert.doesNotMatch(editor.state.writeMessage,/无法.*确认|不能证明/)
})
test('read confirmation with an adoption error exposes stored and local versions separately without enabling save',async()=>{
 const editor=createSettingsEditor({read:async()=>{throw new ApiError('adoption failed',503,undefined,
  {code:'CONFIG_ADOPTION_FAILED',confirmed:wire({...initial,monitorWindowSeconds:30},2),adopted:wire(initial)})},write:async()=>{throw new Error('must not write')}})
 await editor.load();assert.equal(editor.state.current.monitorWindowSeconds,30)
 assert.equal(editor.state.current.version,epoch+':2');assert.equal(editor.state.adopted.version,epoch+':1')
 assert.equal(editor.state.needsConfirmation,true);assert.equal(editor.canSave.value,false)
})

function conflictFixture() {
 let revision=1,remote={...initial},readFailure=null
 const requests=[]
 const editor=createSettingsEditor({
  read:async()=>{if(readFailure)throw readFailure;return wire(remote,revision)},
  write:async request=>{
   requests.push(request)
   if(request.expectedVersion!==epoch+':'+revision)
    throw new ApiError('conflict',409,undefined,{code:'CONFIG_VERSION_CONFLICT',outcome:'not-written',
     current:wire(remote,revision),adopted:wire(remote,revision)})
   const before=wire(remote,revision);remote=model.parseConfig(request);revision++;const after=wire(remote,revision,'committed');return {...after,receipt:receipt(request,after,before)}
  }
 })
 return {editor,requests,update(values){remote={...remote,...values};revision++},failRead(error){readFailure=error}}
}
test('unreviewed conflict differences survive repeated reads of the same version',async()=>{
 const f=conflictFixture(),e=f.editor
 await e.load();e.edit('replenishRate','40');f.update({monitorWindowSeconds:30});await e.save()
 for(let i=0;i<3;i++){
  await e.load()
  assert.deepEqual(e.state.remoteChanges,[{key:'monitorWindowSeconds',before:10,latest:30}])
  assert.equal(e.state.reviewBaseline.version,epoch+':1')
  assert.equal(e.state.current.version,epoch+':2')
  assert.equal(e.state.draft.replenishRate,'40');assert.equal(e.state.draft.monitorWindowSeconds,'30')
  assert.equal(e.state.reviewRequired,true);assert.equal(e.canSave.value,false)
  await e.save();assert.equal(f.requests.length,1)
 }
})
test('newer reads compare against the unreviewed baseline and manual submission uses the latest version',async()=>{
 const f=conflictFixture(),e=f.editor
 await e.load();e.edit('replenishRate','40');f.update({monitorWindowSeconds:30});await e.save()
 f.update({monitorWindowSeconds:45,burstCapacity:60});await e.load()
 assert.deepEqual(e.state.remoteChanges,[
  {key:'burstCapacity',before:40,latest:60},{key:'monitorWindowSeconds',before:10,latest:45}])
 assert.equal(e.state.reviewBaseline.version,epoch+':1')
 assert.equal(e.state.current.version,epoch+':3');assert.equal(e.state.draft.replenishRate,'40')
 assert.equal(e.state.draft.monitorWindowSeconds,'45');assert.equal(e.state.draft.burstCapacity,'60')
 await e.save();assert.equal(f.requests.length,1)
 e.acknowledgeReview();assert.equal(e.state.reviewBaseline,null);assert.deepEqual(e.state.remoteChanges,[])
 await e.save()
 assert.equal(f.requests[1].expectedVersion,epoch+':3')
 assert.equal(f.requests[1].monitorWindowSeconds,45);assert.equal(f.requests[1].burstCapacity,60)
 assert.equal(e.state.current.version,epoch+':4');assert.equal(e.state.writeStatus,'confirmed')
 assert.equal(e.state.reviewBaseline,null);assert.deepEqual(e.state.remoteChanges,[])
})
test('a conflict after acknowledgement starts comparison from the acknowledged version',async()=>{
 const f=conflictFixture(),e=f.editor
 await e.load();e.edit('replenishRate','40');f.update({monitorWindowSeconds:30});await e.save()
 e.acknowledgeReview();f.update({monitorWindowSeconds:50});await e.save();await e.load()
 assert.deepEqual(e.state.remoteChanges,[{key:'monitorWindowSeconds',before:30,latest:50}])
 assert.equal(e.state.reviewBaseline.version,epoch+':2')
 assert.equal(e.state.reviewRequired,true);assert.equal(e.state.draft.replenishRate,'40')
})
test('discarding the draft and clearing the editor discard the pending comparison baseline',async()=>{
 const f=conflictFixture(),e=f.editor
 await e.load();e.edit('replenishRate','40');f.update({monitorWindowSeconds:30});await e.save()
 e.restore()
 assert.equal(e.state.reviewBaseline,null);assert.deepEqual(e.state.remoteChanges,[])
 assert.equal(e.state.reviewRequired,false);assert.equal(e.dirty.value,false)
 e.edit('replenishRate','50');f.update({monitorWindowSeconds:45});await e.save()
 assert.deepEqual(e.state.remoteChanges,[{key:'monitorWindowSeconds',before:30,latest:45}])
 e.clear()
 assert.equal(e.state.reviewBaseline,null);assert.deepEqual(e.state.remoteChanges,[])
 assert.equal(e.state.reviewRequired,false);assert.equal(e.state.current,null)
})
test('read failure and authentication recovery preserve unreviewed differences even if the draft now matches',async()=>{
 const f=conflictFixture(),e=f.editor
 await e.load();e.edit('replenishRate','40');f.update({monitorWindowSeconds:30});await e.save()
 for(const failure of [new Error('read unavailable'),new ApiError('expired',401)]){
  f.failRead(failure);await e.load();e.acknowledgeReview()
  assert.deepEqual(e.state.remoteChanges,[{key:'monitorWindowSeconds',before:10,latest:30}])
  assert.equal(e.state.reviewRequired,true);assert.equal(e.state.reviewBaseline.version,epoch+':1')
 }
 f.update({replenishRate:40});f.failRead(null);await e.load()
 assert.equal(e.dirty.value,false);assert.equal(e.state.authExpired,false)
 assert.deepEqual(e.state.remoteChanges,[
  {key:'replenishRate',before:20,latest:40},{key:'monitorWindowSeconds',before:10,latest:30}])
 assert.equal(e.state.reviewRequired,true);assert.equal(e.protectedDraft.value,true)
 e.acknowledgeReview();assert.equal(e.protectedDraft.value,false);assert.equal(e.state.reviewBaseline,null)
})
test('a remote value returning to the original baseline is a real empty difference and still needs review',async()=>{
 const f=conflictFixture(),e=f.editor
 await e.load();e.edit('replenishRate','40');f.update({monitorWindowSeconds:30});await e.save()
 f.update({monitorWindowSeconds:10});await e.load()
 assert.deepEqual(e.state.remoteChanges,[]);assert.equal(e.state.reviewBaseline.version,epoch+':1')
 assert.equal(e.state.reviewRequired,true);assert.equal(e.state.draft.replenishRate,'40')
 assert.equal(e.canSave.value,false);await e.save();assert.equal(f.requests.length,1)
})


test('operation query proves an old success without regressing a newer baseline or silently overwriting later edits',async()=>{
 let remote=wire(initial),submitted,saved,writes=0,queryIds=[]
 const e=createSettingsEditor({read:async()=>remote,write:async v=>{
  writes++;submitted=v;const after=wire(v,2,'committed');saved=receipt(v,after,remote);throw new Error('HTTP reply lost')
 },query:async id=>{queryIds.push(id);return {status:'committed',receipt:saved,adopted:remote}}})
 await e.load();e.edit('replenishRate','40');await e.save();const id=e.state.operation.operationId
 e.edit('replenishRate','43');remote=wire({...initial,replenishRate:42,monitorWindowSeconds:30},3);await e.load()
 await e.queryOperation()
 assert.equal(e.state.current.version,epoch+':3');assert.equal(e.state.draft.replenishRate,'43')
 assert.equal(e.state.receipt.after.version,epoch+':2');assert.equal(e.state.operationStatus,'committed')
 assert.equal(e.state.reviewRequired,true);assert.equal(writes,1);assert.deepEqual(queryIds,[id])
 assert.equal(e.state.operation.expectedVersion,submitted.expectedVersion)
})
test('receipt query failure and authentication recovery retain original request identity and cannot unlock a second PUT',async()=>{
 let queries=0,writes=0,submitted
 const e=createSettingsEditor({read:async()=>wire(initial),write:async v=>{submitted=v;writes++;throw new Error('lost')},
  query:async id=>{assert.equal(id,submitted.operationId);if(++queries===1)throw new ApiError('expired',401);return {status:'unknown'}}})
 await e.load();e.edit('replenishRate','40');await e.save();const request={...e.state.operation}
 await e.queryOperation();assert.equal(e.state.authExpired,true)
 await e.load();await e.queryOperation();await e.save();e.acknowledgeReview()
 assert.deepEqual(e.state.operation,request);assert.equal(e.state.draft.replenishRate,'40');assert.equal(writes,1)
 assert.equal(e.canSave.value,false);assert.equal(e.state.operationStatus,'unknown');assert.match(e.state.operationMessage,/没有可用回执/)
})
test('known receipt survives a failed follow-up current read and later receipt expiry',async()=>{
 let remote=wire(initial),saved,readUnavailable=false,expired=false
 const e=createSettingsEditor({read:async()=>{if(readUnavailable)throw new Error('unavailable');return remote},
  write:async v=>{saved=receipt(v,wire(v,2),remote);throw new Error('lost')},query:async()=>expired?{status:'unknown'}:{status:'committed',receipt:saved}})
 await e.load();e.edit('replenishRate','40');await e.save();readUnavailable=true;await e.queryOperation()
 assert.equal(e.state.operationStatus,'committed');assert.equal(e.state.needsConfirmation,true)
 assert.match(e.state.operationMessage,/原提交已成功/);assert.equal(e.state.current.version,epoch+':1')
 expired=true;await e.queryOperation();assert.equal(e.state.operationStatus,'committed');assert.match(e.state.operationMessage,/此前已确认/)
})
test('a late current read cannot roll the editor baseline back even after a valid historical receipt',async()=>{
 let remote=wire(initial),saved
 const e=createSettingsEditor({read:async()=>remote,write:async v=>{saved=receipt(v,wire(v,2),remote);throw new Error('lost')},
  query:async()=>({status:'committed',receipt:saved})})
 await e.load();e.edit('replenishRate','40');await e.save();remote=wire({...initial,replenishRate:44},4);await e.load()
 remote=wire({...initial,replenishRate:42},3);await e.queryOperation()
 assert.equal(e.state.current.version,epoch+':4');assert.equal(e.state.draft.replenishRate,'40');assert.match(e.state.readError,/早于/)
})
test('each explicit post-conflict submission gets a new ID, while double-clicks and reads never create another operation',async()=>{
 const f=conflictFixture(),e=f.editor
 await e.load();e.edit('replenishRate','40');f.update({monitorWindowSeconds:30});await e.save()
 const id=e.state.operation.operationId;await e.save();await e.load();assert.equal(e.state.operation.operationId,id)
 e.acknowledgeReview();await e.save();assert.notEqual(e.state.operation.operationId,id);assert.equal(f.requests.length,2)
 assert.equal(e.state.operation.expectedVersion,epoch+':2');assert.equal(e.state.operationStatus,'committed')
})
test('an operation result bound to different submitted values is never attributed to this operation',async()=>{
 let submitted
 const e=createSettingsEditor({read:async()=>wire(initial),write:async v=>{submitted=v;throw new Error('lost')},
  query:async()=>({status:'committed',receipt:receipt({...submitted,replenishRate:41},wire({...submitted,replenishRate:41},2))})})
 await e.load();e.edit('replenishRate','40');await e.save();await e.queryOperation()
 assert.equal(e.state.operationStatus,'unknown');assert.equal(e.state.receipt,null);assert.equal(e.canSave.value,false)
 assert.match(e.state.operationMessage,/不匹配/)
})
