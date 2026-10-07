import {after,before,test as nodeTest} from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'vite'
const test=(name,fn)=>nodeTest(name,{timeout:5000},fn)
const epoch='11111111-1111-4111-8111-111111111111',sourceId='22222222-2222-4222-8222-222222222222'
const initial={rateLimitEnabled:true,replenishRate:20,burstCapacity:40,requestedTokens:1,monitorWindowSeconds:10,emitIntervalSeconds:1}
const target={rateLimitEnabled:false,replenishRate:3,burstCapacity:7,requestedTokens:2,monitorWindowSeconds:30,emitIntervalSeconds:3}
const wire=(values=initial,rev=5)=>({...values,version:epoch+':'+rev})
const readReply=c=>({...c,source:'redis',confirmation:'read',adopted:{...c}})
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}}
let server,createSettingsEditor,ApiError,parseReceipt,confirmSettingsLeave
before(async()=>{
 server=await createServer({configFile:false,optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:false,ws:false},appType:'custom'})
 ;({createSettingsEditor}=await server.ssrLoadModule('/src/settings/editor.ts'))
 ;({ApiError}=await server.ssrLoadModule('/src/api.ts'))
 ;({parseReceipt}=await server.ssrLoadModule('/src/settings/operations.ts'))
 ;({confirmSettingsLeave}=await server.ssrLoadModule('/src/settings/leave.ts'))
})
after(async()=>server.close())
function leave(e,accept) {
 const old=globalThis.window;globalThis.window={confirm:()=>accept,alert:()=>{}}
 try{return confirmSettingsLeave({state:e.state,get protectedDraft(){return e.protectedDraft.value},clear:e.clear})}
 finally{if(old===undefined)delete globalThis.window;else globalThis.window=old}
}
function snapshot(e){return JSON.parse(JSON.stringify(e.state))}
async function fixture() {
 const f={remote:wire(),target:wire(target,2),source:{version:epoch+':2',operationId:sourceId},mode:'normal',calls:[],readCount:0,queryIds:[],
  query:null,history:null,preview:null,receipt:null}
 const preview=source=>({origin:'redis-history',current:f.remote,adopted:f.remote,target:{...f.target,version:source.version},source:{...source,recordedAt:1},checkedAt:2,
  noChanges:Object.keys(initial).every(k=>f.target[k]===f.remote[k])})
 f.previewResult=preview
 const sourceReceipt=()=>({operationType:'update',operationId:sourceId,expectedVersion:epoch+':1',request:target,before:wire(initial,1),after:wire(target,2),
  status:'committed',recordedAt:1,expiresAt:86400001,instanceId:epoch})
 f.historyResult=()=>({source:'redis-history',entries:[sourceReceipt()],nextCursor:null,checkedAt:2})
 const e=createSettingsEditor({
  read:async()=>{f.readCount++;return readReply(f.remote)},
  write:async()=>{throw new Error('Normal PUT must not be scheduled by rollback/history')},
  history:(cursor,signal)=>f.history?f.history(cursor,signal):Promise.resolve(f.historyResult()),
  previewRollback:(source,signal)=>f.preview?f.preview(source,signal):Promise.resolve(preview(source)),
  rollback:async operation=>{
   f.calls.push(structuredClone(operation))
   if(f.mode==='conflict') {
    f.remote=wire({...initial,replenishRate:99},6)
    throw new ApiError('conflict',409,undefined,{code:'CONFIG_VERSION_CONFLICT',outcome:'not-written',current:f.remote,adopted:f.remote})
   }
   if(f.mode==='gone')throw new ApiError('来源不再保留',410,undefined,{code:'CONFIG_HISTORY_UNAVAILABLE',outcome:'not-written'})
   const before={...f.remote},after={...f.target,version:epoch+':'+(Number(before.version.slice(37))+1)}
   f.receipt={operationType:'rollback',operationId:operation.operationId,expectedVersion:operation.expectedVersion,
    source:{...operation.source,recordedAt:1},request:{...target},before,after,status:'committed',recordedAt:3,expiresAt:86400003,instanceId:epoch}
   // Preserve fixture changes used by the no-change scenario.
   for(const key of Object.keys(initial))f.receipt.request[key]=after[key]
   f.remote=after
   if(f.mode==='lost')throw new Error('lost HTTP response')
   return {...readReply(after),confirmation:'committed',receipt:f.receipt}
  },
  query:async(id,signal)=>{
   f.queryIds.push(id)
   return f.query?f.query(id,signal):{status:'committed',receipt:f.receipt,adopted:f.remote}
  }
 })
 f.editor=e;await e.load();return f
}
async function select(f){await f.editor.loadHistory();await f.editor.previewRollback(f.source);f.editor.state.rollbackReviewed=true}

test('history selection preserves ordinary drafts and requires explicit six-field review before a typed recovery',async()=>{
 const f=await fixture(),e=f.editor;e.edit('replenishRate','43')
 await e.loadHistory();await e.previewRollback(f.source)
 assert.equal(e.state.draft.replenishRate,'43');assert.equal(e.canRollback.value,false);assert.equal(e.canSave.value,false)
 await e.rollback();assert.equal(f.calls.length,0)
 e.state.rollbackReviewed=true;await e.rollback()
 assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].source,f.source)
 assert.equal(f.calls[0].operationType,'rollback');assert.equal(f.calls[0].expectedVersion,epoch+':5')
 assert.equal('replenishRate' in f.calls[0],false)
 assert.equal(e.state.current.version,epoch+':6');assert.equal(e.state.draft.replenishRate,'3')
 assert.equal(e.state.receipt.source.operationId,sourceId);assert.equal(e.protectedDraft.value,false)
})
test('equal values are explicitly reported but a confirmed recovery still creates a new version',async()=>{
 const f=await fixture(),e=f.editor;f.target=wire(initial,2);await select(f)
 assert.equal(e.state.rollbackPreview.noChanges,true);assert.equal(e.dirty.value,false)
 await e.rollback();assert.equal(e.state.current.version,epoch+':6');assert.equal(e.state.operationStatus,'committed')
})
test('conflict preserves source and draft; rereading alone cannot substitute a new expectedVersion or retry',async()=>{
 const f=await fixture(),e=f.editor;e.edit('replenishRate','43');await select(f);f.mode='conflict';await e.rollback()
 const id=e.state.operation.operationId
 assert.equal(e.state.rollbackPreview.current.version,epoch+':5');assert.deepEqual(e.state.rollbackSource,f.source)
 assert.equal(e.state.current.version,epoch+':6');assert.equal(e.state.draft.replenishRate,'43');assert.equal(e.canRollback.value,false)
 await e.load();await e.rollback();assert.equal(f.calls.length,1);assert.equal(e.state.operation.operationId,id)
 await e.previewRollback(f.source);assert.equal(e.state.rollbackReviewed,false);assert.equal(e.canRollback.value,false)
 e.state.rollbackReviewed=true;f.mode='normal';await e.rollback()
 assert.notEqual(e.state.operation.operationId,id);assert.equal(f.calls[1].expectedVersion,epoch+':6');assert.equal(e.state.current.version,epoch+':7')
})
test('source disappearance rejects recovery and preserves ordinary drafts without a fallback write',async()=>{
 const f=await fixture(),e=f.editor;e.edit('replenishRate','43');await select(f);f.mode='gone';await e.rollback()
 assert.equal(e.state.writeStatus,'rejected');assert.equal(e.state.operationStatus,'rejected');assert.equal(e.state.needsConfirmation,false)
 assert.equal(e.state.rollbackPreview,null);assert.match(e.state.rollbackError,/不再保留/);assert.equal(e.state.draft.replenishRate,'43')
 await e.rollback();assert.equal(f.calls.length,1)
})
test('lost recovery response queries the same operation without regressing a newer baseline or losing subsequent edits',async()=>{
 const f=await fixture(),e=f.editor;await select(f);f.mode='lost';await e.rollback();const id=e.state.operation.operationId
 e.edit('replenishRate','43');f.remote=wire({...initial,replenishRate:88},7);await e.load()
 await e.rollback();await e.save();assert.equal(f.calls.length,1)
 await e.queryOperation();assert.equal(e.state.operation.operationId,id);assert.deepEqual(f.queryIds,[id])
 assert.equal(e.state.receipt.after.version,epoch+':6');assert.equal(e.state.current.version,epoch+':7')
 assert.equal(e.state.draft.replenishRate,'43');assert.equal(e.state.rollbackSource,null);assert.equal(e.state.reviewRequired,true)
})
for(const outcome of ['success','401']) {
 test(`discard invalidates pending history ${outcome} without altering new drafts or a new history request`,async()=>{
  const f=await fixture(),e=f.editor,old=deferred(),next=deferred();let calls=0,oldSignal
  e.edit('replenishRate','43');f.history=(_cursor,signal)=>{if(++calls===1){oldSignal=signal;return old.promise}return next.promise}
  const pending=e.loadHistory();assert.equal(leave(e,true),true);assert.equal(oldSignal.aborted,true)
  await e.load();e.edit('replenishRate','45');const newer=e.loadHistory(),before=snapshot(e)
  if(outcome==='success')old.resolve(f.historyResult());else old.reject(new ApiError('old expired credentials',401))
  await pending;assert.deepEqual(snapshot(e),before);assert.equal(e.state.historyLoading,true)
  next.resolve(f.historyResult());await newer
  assert.equal(e.state.draft.replenishRate,'45');assert.equal(e.state.operation,null);assert.equal(f.calls.length,0)
 })
}
for(const outcome of ['success','401']) {
 test(`new source selection invalidates old preview ${outcome}, including its finally callback`,async()=>{
  const f=await fixture(),e=f.editor,old=deferred(),next=deferred();let calls=0,oldSignal
  f.preview=(_source,signal)=>{if(++calls===1){oldSignal=signal;return old.promise}return next.promise}
  const pending=e.previewRollback(f.source),another={version:epoch+':3',operationId:'33333333-3333-4333-8333-333333333333'}
  const newer=e.previewRollback(another),before=snapshot(e);assert.equal(oldSignal.aborted,true)
  if(outcome==='success')old.resolve(f.previewResult(f.source));else old.reject(new ApiError('old expired credentials',401))
  await pending;assert.deepEqual(snapshot(e),before);assert.equal(e.state.rollbackLoading,true)
  next.resolve(f.previewResult(another));await newer;assert.deepEqual(e.state.rollbackSource,another)
  assert.equal(e.state.rollbackReviewed,false);assert.equal(f.calls.length,0)
 })
}
test('cancelling leave keeps a pending preview; explicit discard makes its late completion inert',async()=>{
 const f=await fixture(),e=f.editor,waiting=deferred();f.preview=()=>waiting.promise
 const pending=e.previewRollback(f.source),before=snapshot(e)
 assert.equal(leave(e,false),false);assert.deepEqual(snapshot(e),before)
 assert.equal(leave(e,true),true);const cleared=snapshot(e)
 waiting.resolve(f.previewResult(f.source));await pending
 assert.deepEqual(snapshot(e),cleared);assert.equal(e.protectedDraft.value,false);assert.equal(f.calls.length,0)
})
test('authentication recovery retains pending recovery identity and normal draft; querying after reconnect does not resubmit',async()=>{
 const f=await fixture(),e=f.editor;e.edit('replenishRate','43');await select(f);f.mode='lost';await e.rollback();const id=e.state.operation.operationId
 f.query=async()=>{throw new ApiError('expired',401)};await e.queryOperation();e.cancelRead();e.cancelHistoryReads()
 assert.equal(e.state.authExpired,true);assert.equal(e.state.draft.replenishRate,'43');assert.deepEqual(e.state.rollbackSource,f.source)
 f.query=null;await e.load();await e.queryOperation()
 assert.equal(e.state.operation.operationId,id);assert.deepEqual(f.queryIds,[id,id]);assert.equal(f.calls.length,1)
 assert.equal(e.state.draft.replenishRate,'43');assert.equal(e.state.operationStatus,'committed')
})
test('a rollback receipt cannot be attributed to a different source or to an ordinary update with identical values',async()=>{
 const f=await fixture(),e=f.editor;await select(f);await e.rollback();const request=f.calls[0]
 assert.throws(()=>parseReceipt(f.receipt,{...request,source:{...request.source,operationId:epoch}}),/来源/)
 assert.throws(()=>parseReceipt(f.receipt,{...target,expectedVersion:request.expectedVersion,operationId:request.operationId}),/不匹配/)
})

test('a fresh current read invalidates an older reviewed preview until the user explicitly refreshes and checks it again',async()=>{
 const f=await fixture(),e=f.editor;await select(f)
 f.remote=wire({...initial,replenishRate:99},6);await e.load()
 assert.equal(e.state.rollbackPreview.current.version,epoch+':5');assert.equal(e.state.rollbackReviewed,false)
 e.state.rollbackReviewed=true;await e.rollback();assert.equal(f.calls.length,0)
 await e.previewRollback(f.source);assert.equal(e.state.rollbackPreview.current.version,epoch+':6')
 assert.equal(e.state.rollbackReviewed,false);assert.equal(e.canRollback.value,false)
 e.state.rollbackReviewed=true;await e.rollback();assert.equal(f.calls[0].expectedVersion,epoch+':6')
})
