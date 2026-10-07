import {before,after,test as nodeTest} from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'vite'
let server,createRouteEditor,confirmRouteLeave,parsePublication,ApiError
const test=(name,fn)=>nodeTest(name,{timeout:5000},fn)
const epoch='11111111-1111-4111-8111-111111111111'
const route={id:'orders',path:'/orders/**',uri:'http://v1:9000',rewriteEnabled:true,rewriteRegex:'^/orders/(?<segment>.*)$',rewriteReplacement:'/${segment}',circuitBreakerEnabled:true,circuitBreakerName:'cb-orders',fallbackPath:'/fallback/default'}
const snapshot=(n=1,r=route)=>({schemaVersion:1,version:epoch+':'+n,routes:r?[{...r}]:[]})
const wire=(s=snapshot(),adopted=s.version)=>({version:s.version,routes:s.routes,snapshot:s,instanceId:'test-instance',adoptedVersion:adopted,adoption:adopted===s.version?'adopted':'pending'})
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}}
before(async()=>{
 server=await createServer({configFile:false,optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:false,ws:false},appType:'custom'})
 ;({createRouteEditor,confirmRouteLeave}=await server.ssrLoadModule('/src/routes/editor.ts'));({parsePublication}=await server.ssrLoadModule('/src/routes/publication.ts'));({ApiError}=await server.ssrLoadModule('/src/api.ts'))
})
after(async()=>{await server.close()})
function fixture(){const f={writes:[],reads:0,current:snapshot(),write:undefined,read:undefined};f.editor=createRouteEditor({read:signal=>{f.reads++;return f.read?f.read(signal):Promise.resolve(wire(f.current))},write:async(kind,id,body,signal)=>{f.writes.push({kind,id,body,signal});if(f.write)return f.write(kind,id,body,signal);f.current=snapshot(Number(f.current.version.slice(37))+1,kind==='delete'?null:body.route);return {...wire(f.current),outcome:'committed'}}});f.editor.begin(f.current,route);return f}
function leave(e,answer){const old=globalThis.window;globalThis.window={confirm:()=>answer};try{return confirmRouteLeave({state:e.state,get protectedDraft(){return e.protectedDraft.value},discard:e.discard})}finally{if(old===undefined)delete globalThis.window;else globalThis.window=old}}
test('explicit submit carries the reviewed version and publishes only once',async()=>{const f=fixture();f.editor.state.draft.uri='http://draft:9000';await f.editor.submit();assert.equal(f.writes.length,1);assert.equal(f.writes[0].body.expectedVersion,epoch+':1');assert.equal(f.editor.state.open,false);assert.match(f.editor.state.message,/本实例已生效/);assert.equal(f.reads,0)})
test('conflict preserves both the old comparison baseline and the draft across another read',async()=>{
 const f=fixture(),e=f.editor;e.state.draft.uri='http://draft:9000';f.current=snapshot(2,{...route,uri:'http://someone-else:9000'});f.write=()=>{throw new ApiError('conflict',409,undefined,{outcome:'not-written',current:f.current})};await e.submit();await e.readCurrent()
 assert.equal(e.state.base.version,epoch+':1');assert.equal(e.state.draft.uri,'http://draft:9000');assert.equal(e.currentRoute.value.uri,'http://someone-else:9000');assert.equal(e.canSubmit.value,false);await e.submit();assert.equal(f.writes.length,1)
 e.confirmReview();assert.equal(e.state.base.version,epoch+':2');assert.equal(e.canSubmit.value,true);assert.equal(f.writes.length,1)
 f.write=undefined;await e.submit();assert.equal(f.writes[1].body.expectedVersion,epoch+':2')
})
test('unknown response never retries, and equal current values cannot prove the original success',async()=>{const f=fixture(),e=f.editor;e.state.draft.uri='http://desired:9000';f.write=()=>{throw new Error('response lost')};await e.submit();f.current=snapshot(2,e.state.draft);await e.readCurrent();assert.equal(e.state.status,'unknown');assert.equal(e.state.base.version,epoch+':1');assert.equal(f.writes.length,1);assert.match(e.state.message,/不能证明/);assert.equal(e.canSubmit.value,false);e.confirmReview();assert.equal(f.writes.length,1)})
test('confirmed storage with pending adoption never claims all instances or even this instance applied',async()=>{const f=fixture();f.write=async()=>({...wire(snapshot(2),epoch+':1'),outcome:'committed'});await f.editor.submit();assert.equal(f.editor.state.status,'committed');assert.match(f.editor.state.message,/本实例待生效/)})
test('duplicate clicks are bounded to one outstanding publication',async()=>{const f=fixture(),gate=deferred();f.write=()=>gate.promise;const first=f.editor.submit();await f.editor.submit();assert.equal(f.writes.length,1);gate.resolve({...wire(snapshot(2)),outcome:'committed'});await first})
test('cancel leaving preserves an unresolved draft and its version',async()=>{const f=fixture();f.editor.state.draft.uri='http://draft';assert.equal(leave(f.editor,false),false);assert.equal(f.editor.state.draft.uri,'http://draft');assert.equal(f.editor.state.base.version,epoch+':1')})
for(const outcome of ['success','failure','401'])test('discard makes late current-state read inert: '+outcome,async()=>{
 const f=fixture(),e=f.editor;e.state.reviewRequired=true;e.state.status='unknown';e.state.draft.uri='http://abandoned';const gate=deferred();f.read=()=>gate.promise;const reading=e.readCurrent();assert.equal(leave(e,true),true)
 e.begin(snapshot(5),{...route,uri:'http://new-draft'});const fresh=JSON.stringify(e.state)
 if(outcome==='success')gate.resolve(wire(snapshot(2)));else gate.reject(outcome==='401'?new ApiError('expired',401):new Error('lost'))
 await reading;assert.equal(JSON.stringify(e.state),fresh);assert.equal(f.writes.length,0)
})
test('discard makes a late publication acknowledgement inert for the next editor',async()=>{const f=fixture(),e=f.editor,gate=deferred();e.state.draft.uri='http://abandoned';f.write=()=>gate.promise;const sending=e.submit();assert.equal(leave(e,true),true);e.begin(snapshot(5),{...route,uri:'http://new-draft'});const fresh=JSON.stringify(e.state);gate.resolve({...wire(snapshot(2)),outcome:'committed'});await sending;assert.equal(JSON.stringify(e.state),fresh)})
test('authentication recovery keeps the draft and requires a new read and explicit review',async()=>{const f=fixture(),e=f.editor;e.state.draft.uri='http://draft';f.write=()=>{throw new ApiError('expired',401)};await e.submit();e.cancelRead();assert.equal(e.state.draft.uri,'http://draft');assert.equal(e.state.authExpired,true);assert.equal(e.canSubmit.value,false);f.current=snapshot(2);await e.readCurrent();assert.equal(e.state.authExpired,false);assert.equal(e.canSubmit.value,false);e.confirmReview();assert.equal(e.canSubmit.value,true);assert.equal(f.writes.length,1)})
test('a superseded read cannot replace a newer comparison',async()=>{const f=fixture(),e=f.editor,gate=deferred();f.read=()=>gate.promise;const old=e.readCurrent();e.cancelRead();f.read=async()=>wire(snapshot(4));await e.readCurrent();gate.resolve(wire(snapshot(2)));await old;assert.equal(e.state.latest.version,epoch+':4');assert.equal(e.state.base.version,epoch+':1')})
test('delete binds the reviewed full snapshot version and is protected',async()=>{const f=fixture(),e=f.editor;e.discard();e.begin(snapshot(),route,'delete');assert.equal(e.protectedDraft.value,true);await e.submit();assert.deepEqual(f.writes[0].body,{expectedVersion:epoch+':1'});assert.equal(f.writes[0].kind,'delete')})
test('old array or false responses never become a valid empty route snapshot',()=>{for(const v of [false,[],null,{routes:[]}])assert.throws(()=>parsePublication(v));assert.deepEqual(parsePublication(wire(snapshot(2,null))).routes,[])})

for(const outcome of ['rejected','conflict','unknown','authentication'])test('pending save releases its lock and retains the draft after '+outcome,async()=>{
 const f=fixture(),e=f.editor,gate=deferred();e.state.draft.path='/pending-draft/**';f.write=()=>gate.promise
 const sending=e.submit();assert.equal(e.state.saving,true);assert.equal(e.canSubmit.value,false);assert.equal(e.protectedDraft.value,true)
 await e.submit();assert.equal(f.writes.length,1)
 const error=outcome==='conflict'?new ApiError('conflict',409,undefined,{outcome:'not-written',current:snapshot(2)}):
  outcome==='rejected'?new ApiError('invalid route',400,undefined,{outcome:'not-written'}):
  outcome==='authentication'?new ApiError('expired',401):new Error('response lost')
 gate.reject(error);await sending
 assert.equal(e.state.saving,false);assert.equal(e.state.open,true);assert.equal(e.state.draft.path,'/pending-draft/**')
 assert.equal(e.state.base.version,epoch+':1');assert.equal(e.protectedDraft.value,true);assert.equal(f.writes.length,1)
 assert.equal(e.canSubmit.value,outcome==='rejected')
 assert.equal(e.state.status,outcome==='authentication'?'rejected':outcome)
})
