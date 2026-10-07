import {after,before,test as nodeTest} from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'vite'

const test=(name,fn)=>nodeTest(name,{timeout:5_000},fn)
let server,createSettingsEditor,confirmSettingsLeave,ApiError,model
const initial={rateLimitEnabled:true,replenishRate:20,burstCapacity:40,requestedTokens:1,monitorWindowSeconds:10,emitIntervalSeconds:1}
const epoch='11111111-1111-4111-8111-111111111111'
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}}
before(async()=>{
 server=await createServer({configFile:false,optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:false,ws:false},appType:'custom'})
 ;({createSettingsEditor}=await server.ssrLoadModule('/src/settings/editor.ts'))
 ;({confirmSettingsLeave}=await server.ssrLoadModule('/src/settings/leave.ts'))
 ;({ApiError}=await server.ssrLoadModule('/src/api.ts'))
 model=await server.ssrLoadModule('/src/settings/model.ts')
})
after(async()=>{await server.close()})
function leave(editor,accept) {
 const previous=globalThis.window,dialogs=[]
 globalThis.window={confirm:message=>{dialogs.push(message);return accept},alert:message=>dialogs.push(message)}
 try {
  const allowed=confirmSettingsLeave({state:editor.state,get protectedDraft(){return editor.protectedDraft.value},clear:editor.clear})
  return {allowed,dialogs}
 } finally {
  if(previous===undefined)delete globalThis.window
  else globalThis.window=previous
 }
}
function snapshot(editor) {return JSON.parse(JSON.stringify(editor.state))}
async function fixture() {
 const f={reads:[],writes:[],queries:[],receipts:new Map(),remote:{...initial,version:epoch+':1'},readOverride:null}
 const editor=createSettingsEditor({
  read:async signal=>{
   f.reads.push(signal)
   if(f.readOverride)return f.readOverride(signal)
   return {...f.remote,source:'redis',confirmation:'read',adopted:{...f.remote}}
  },
  write:async request=>{
   f.writes.push(request)
   const before={...f.remote}
   f.remote={...model.parseConfig(request),version:epoch+':'+(Number(before.version.slice(37))+1)}
   f.receipts.set(request.operationId,{operationId:request.operationId,expectedVersion:request.expectedVersion,
    request:model.parseConfig(request),before,after:{...f.remote},status:'committed',recordedAt:f.writes.length,
    expiresAt:86400000+f.writes.length,instanceId:epoch})
   throw new Error('HTTP response lost')
  },
  query:(id,signal)=>{
   const gate=deferred()
   f.queries.push({id,signal,...gate})
   // Deliberately ignore abort: correctness must also cover already-completed transports.
   return gate.promise
  }
 })
 f.editor=editor
 f.result=query=>({status:'committed',receipt:f.receipts.get(query.id),adopted:{...f.remote}})
 await editor.load();editor.edit('replenishRate','40');await editor.save();editor.edit('replenishRate','43')
 return f
}

for(const outcome of ['committed','unknown','network failure','401']) {
 test(`confirmed discard clears immediately and ignores a late receipt ${outcome}`,async()=>{
  const f=await fixture(),e=f.editor,pending=e.queryOperation(),query=f.queries[0]
  const decision=leave(e,true),discarded=snapshot(e)
  if(outcome==='network failure')query.reject(new Error('late network failure'))
  else if(outcome==='401')query.reject(new ApiError('late expired credentials',401))
  else query.resolve(outcome==='committed'?f.result(query):{status:'unknown'})
  await pending
  assert.equal(decision.allowed,true);assert.match(decision.dialogs[0],/丢弃本页草稿/)
  assert.equal(discarded.current,null);assert.equal(discarded.operation,null)
  assert.equal(discarded.draft.replenishRate,'');assert.equal(discarded.querying,false)
  assert.equal(query.signal.aborted,true)
  assert.deepEqual(snapshot(e),discarded,'late success, error and finally must have no state effects')
  assert.equal(e.protectedDraft.value,false);assert.equal(f.reads.length,1);assert.equal(f.writes.length,1)
  await e.load()
  assert.equal(e.state.draft.replenishRate,'40');assert.equal(e.state.operation,null)
  assert.equal(e.dirty.value,false);assert.equal(e.protectedDraft.value,false);assert.equal(f.reads.length,2)
 })
}

for(const outcome of ['committed','401']) {
 test(`a late abandoned query ${outcome} cannot affect a new operation or unlock its pending query`,async()=>{
  const f=await fixture(),e=f.editor,oldPending=e.queryOperation(),old=f.queries[0]
  leave(e,true);await e.load();e.edit('replenishRate','44');await e.save()
  const nextPending=e.queryOperation(),next=f.queries.at(-1),before=snapshot(e),reads=f.reads.length
  if(outcome==='401')old.reject(new ApiError('old credentials',401))
  else old.resolve(f.result(old))
  await oldPending
  assert.notEqual(next.id,old.id);assert.deepEqual(snapshot(e),before)
  assert.equal(e.state.querying,true);assert.equal(next.signal.aborted,false);assert.equal(f.reads.length,reads)
  next.resolve(f.result(next));await nextPending
  assert.equal(e.state.querying,false);assert.equal(e.state.receipt.operationId,next.id)
  assert.equal(e.state.current.replenishRate,44);assert.equal(f.writes.length,2)
 })
}

test('discard also invalidates the current-config read already started by a receipt',async()=>{
 const f=await fixture(),e=f.editor,reading=deferred(),started=deferred()
 f.readOverride=signal=>{started.resolve(signal);return reading.promise}
 const pending=e.queryOperation(),query=f.queries[0]
 query.resolve(f.result(query));const signal=await started.promise
 assert.equal(e.state.loading,true);assert.equal(e.state.operationStatus,'committed')
 const decision=leave(e,true),discarded=snapshot(e)
 reading.resolve({...f.remote,source:'redis',confirmation:'read',adopted:{...f.remote}});await pending
 assert.equal(decision.allowed,true);assert.equal(signal.aborted,true)
 assert.equal(e.state.current,null);assert.equal(e.state.operation,null);assert.deepEqual(snapshot(e),discarded)
 assert.equal(f.reads.length,2);assert.equal(f.writes.length,1)
})

test('cancelling leave retains the pending query, operation ID and subsequent draft edits',async()=>{
 const f=await fixture(),e=f.editor,pending=e.queryOperation(),query=f.queries[0],before=snapshot(e)
 const decision=leave(e,false)
 assert.equal(decision.allowed,false);assert.deepEqual(snapshot(e),before);assert.equal(query.signal.aborted,false)
 query.resolve(f.result(query));await pending
 assert.equal(e.state.operation.operationId,query.id);assert.equal(e.state.operationStatus,'committed')
 assert.equal(e.state.current.replenishRate,40);assert.equal(e.state.draft.replenishRate,'43')
 assert.equal(e.state.reviewRequired,true);assert.equal(e.canSave.value,false)
 assert.equal(f.reads.length,2);assert.equal(f.writes.length,1)
})

test('authentication unmount and recovery preserve the operation and draft until explicit discard',async()=>{
 const f=await fixture(),e=f.editor,pending=e.queryOperation(),query=f.queries[0]
 e.cancelRead() // Settings unmounts when authentication expires; this is not explicit discard.
 query.reject(new ApiError('expired',401));await pending
 assert.equal(query.signal.aborted,false);assert.equal(e.state.authExpired,true)
 assert.equal(e.state.operation.operationId,query.id);assert.equal(e.state.draft.replenishRate,'43')
 await e.load();assert.equal(e.state.authExpired,false);assert.equal(e.state.needsConfirmation,true)
 const again=e.queryOperation(),retry=f.queries.at(-1)
 assert.equal(retry.id,query.id);retry.resolve(f.result(retry));await again
 assert.equal(e.state.operationStatus,'committed');assert.equal(e.state.draft.replenishRate,'43')
 assert.equal(e.state.current.replenishRate,40);assert.equal(e.state.reviewRequired,true);assert.equal(f.writes.length,1)
})

test('a pending write still blocks leaving and cannot be discarded',async()=>{
 const waiting=deferred(),e=createSettingsEditor({
  read:async()=>({...initial,version:epoch+':1',source:'redis',confirmation:'read',adopted:{...initial,version:epoch+':1'}}),
  write:()=>waiting.promise
 })
 await e.load();e.edit('replenishRate','43');const pending=e.save(),before=snapshot(e)
 const decision=leave(e,true);e.clear()
 assert.equal(decision.allowed,false);assert.match(decision.dialogs[0],/等待服务端保存响应/)
 assert.deepEqual(snapshot(e),before)
 waiting.reject(new Error('lost'));await pending
 assert.equal(e.state.draft.replenishRate,'43');assert.equal(e.state.needsConfirmation,true)
})
