import { computed, reactive } from 'vue'
import { defineStore } from 'pinia'
import { apiRequest, ApiError, errorMessage } from '../api'
import type { RouteRule } from '../stores/traffic'
import { emptyRoute, parsePublication, type RoutePublication, type RouteSnapshot } from './publication'
export interface RouteEditState {
 open:boolean; kind:'save'|'delete'; original:RouteRule|null; draft:RouteRule; base:RouteSnapshot|null; latest:RouteSnapshot|null;
 saving:boolean; reading:boolean; reviewRequired:boolean; authExpired:boolean; status:'idle'|'conflict'|'unknown'|'rejected'|'committed'; message:string; readError:string
}
interface Client { read(signal:AbortSignal):Promise<RoutePublication>; write(kind:'save'|'delete',id:string,body:unknown,signal:AbortSignal):Promise<RoutePublication> }
const copy=<T>(value:T):T=>JSON.parse(JSON.stringify(value))
export function createRouteEditor(client:Client) {
 const state=reactive<RouteEditState>({open:false,kind:'save',original:null,draft:emptyRoute(),base:null,latest:null,saving:false,reading:false,reviewRequired:false,authExpired:false,status:'idle',message:'',readError:''})
 let lifecycle=0,readSequence=0,readController:AbortController|undefined,writeController:AbortController|undefined
 const protectedDraft=computed(()=>state.open&&(state.kind==='delete'||state.saving||state.reviewRequired||JSON.stringify(state.draft)!==JSON.stringify(state.original??emptyRoute())))
 const canSubmit=computed(()=>state.open&&!!state.base&&!state.saving&&!state.reading&&!state.reviewRequired&&!state.authExpired&&!state.readError)
 const comparison=computed(()=>state.latest??state.base)
 const currentRoute=computed(()=>comparison.value?.routes.find(r=>r.id===state.draft.id)??null)
 function begin(base:RouteSnapshot,route:RouteRule|null,kind:'save'|'delete'='save') {
  if(state.open)throw new Error('请先处理当前路由草稿。')
  lifecycle++;Object.assign(state,{open:true,kind,base:copy(base),latest:null,original:copy(route),draft:route?copy(route):emptyRoute(),saving:false,reading:false,reviewRequired:false,authExpired:false,status:'idle',message:'',readError:''})
 }
 function cancelRead(){readSequence++;readController?.abort();readController=undefined;state.reading=false}
 function discard(){lifecycle++;cancelRead();writeController?.abort();writeController=undefined;Object.assign(state,{open:false,base:null,latest:null,original:null,draft:emptyRoute(),saving:false,reading:false,reviewRequired:false,authExpired:false,status:'idle',message:'',readError:''})}
 function authenticationExpired(){if(state.open){state.authExpired=true;state.reviewRequired=true;cancelRead()}}
 async function readCurrent(){
  if(state.reading||state.saving||!state.open)return
  const generation=lifecycle,seq=++readSequence;readController=new AbortController();state.reading=true;state.readError=''
  try{
   const result=parsePublication(await client.read(readController.signal));if(generation!==lifecycle||seq!==readSequence)return
   const prior=state.latest??state.base
   if(prior&&prior.version.slice(0,36)===result.version.slice(0,36)&&Number(prior.version.slice(37))>Number(result.version.slice(37)))throw new Error('读取响应早于已核对版本，请重试。')
   state.latest=copy(result.snapshot);state.authExpired=false;state.reviewRequired=true
   if(state.status==='unknown')state.message='当前状态已读取；这不能证明原提交是否成功。核对后可明确发起一次新的提交。'
  }catch(error){if(generation!==lifecycle||seq!==readSequence)return;state.readError=errorMessage(error);if(error instanceof ApiError&&error.status===401)state.authExpired=true}
  finally{if(generation===lifecycle&&seq===readSequence)state.reading=false}
 }
 function confirmReview(){
  if(!state.latest||state.reading||state.saving||state.authExpired||state.readError)return
  state.base=copy(state.latest);state.latest=null;state.reviewRequired=false;state.status='idle';state.message='已按当前版本核对。草稿保持不变，请明确再次发布。'
 }
 async function submit():Promise<RoutePublication|undefined>{
  if(!canSubmit.value)return
  const generation=lifecycle;state.saving=true;state.message='';writeController=new AbortController()
  // Assign a new route identity before sending; an uncertain response must not create another identity automatically.
  if(state.kind==='save'&&!state.draft.id.trim())state.draft.id='route-'+crypto.randomUUID()
  const body=state.kind==='delete'?{expectedVersion:state.base!.version}:{expectedVersion:state.base!.version,route:copy(state.draft)}
  try{
   const result=parsePublication(await client.write(state.kind,state.draft.id,body,writeController.signal));if(generation!==lifecycle)return
   if(result.outcome!=='committed')throw new Error('服务端未返回可靠的路由提交确认。')
   state.status='committed';state.open=false;state.reviewRequired=false
   state.message=result.adoption==='adopted'?'存储已提交，本实例已生效；其他实例异步采用。':result.adoption==='newer'?'本次存储已提交，本实例已采用更高版本。':'存储已提交，本实例待生效；请查看同步诊断。'
   return result
  }catch(error){
   if(generation!==lifecycle)return
   if(error instanceof ApiError&&error.status===409&&error.details?.current){state.latest=copy(error.details.current as RouteSnapshot);state.reviewRequired=true;state.status='conflict';state.message='版本冲突，草稿已保留。请比较当前值与待提交内容，核对后再发布。'}
   else if(error instanceof ApiError&&(error.details?.outcome==='not-written'||[400,401,403,404,422,428].includes(error.status))){state.status='rejected';state.message=errorMessage(error);if(error.status===401)authenticationExpired()}
   else{state.status='unknown';state.reviewRequired=true;state.message='提交结果未知，草稿已保留。没有自动重发；读取当前状态不能确认原提交。'}
  }finally{if(generation===lifecycle)state.saving=false}
 }
 return {state,protectedDraft,canSubmit,comparison,currentRoute,begin,discard,cancelRead,authenticationExpired,readCurrent,confirmReview,submit}
}
export const useRouteEditorStore=defineStore('route-publication-editor',()=>createRouteEditor({
 read:signal=>apiRequest('/settings/routes',{signal:AbortSignal.any([signal,AbortSignal.timeout(10000)])}),
 write:(kind,id,body,signal)=>apiRequest(kind==='save'?'/settings/routes':'/settings/routes/'+encodeURIComponent(id),{method:kind==='save'?'POST':'DELETE',body:JSON.stringify(body),signal:AbortSignal.any([signal,AbortSignal.timeout(10000)])})
}))
export function confirmRouteLeave(editor:{protectedDraft:boolean;state:RouteEditState;discard():void}){
 if(!editor.protectedDraft){editor.discard();return true}
 if(!window.confirm(editor.state.saving||editor.state.status==='unknown'?'丢弃草稿并离开？这不会撤销服务端可能已经执行的路由发布。':'存在尚未提交或核对的路由修改。丢弃草稿并离开？'))return false
 editor.discard();return true
}
