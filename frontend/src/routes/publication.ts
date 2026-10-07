import type { RouteRule } from '../stores/traffic'
export interface RouteSnapshot { schemaVersion:1; version:string; routes:RouteRule[] }
export interface RoutePublication { version:string; routes:RouteRule[]; snapshot:RouteSnapshot; instanceId:string; adoptedVersion:string|null; adoption:'adopted'|'pending'|'newer'; outcome?:'committed'; adoptionIssue?:string|null }
export interface RouteDiagnostics { instanceId:string; status:string; adoptedVersion:string|null; lastObservedVersion:string|null; lastObservedAt:string|null; lastAdoptedAt:string|null; reason:string|null; stale:boolean }
export function parsePublication(value: unknown): RoutePublication {
  const v=value as RoutePublication
  if(!v || typeof v.version!=='string' || !/^[0-9a-f-]{36}:[1-9]\d*$/.test(v.version) || !Array.isArray(v.routes) || !v.snapshot || v.snapshot.version!==v.version || !Array.isArray(v.snapshot.routes)) throw new Error('路由响应不含有效的版本化完整快照，请检查服务端协议。')
  return v
}
export const routeFields: {key:keyof RouteRule;label:string}[] = [
 {key:'id',label:'路由 ID'},{key:'path',label:'匹配路径'},{key:'uri',label:'目标地址'},
 {key:'rewriteEnabled',label:'路径重写'},{key:'rewriteRegex',label:'重写正则'},{key:'rewriteReplacement',label:'替换目标'},
 {key:'circuitBreakerEnabled',label:'熔断保护'},{key:'circuitBreakerName',label:'熔断器名称'},{key:'fallbackPath',label:'降级路径'}]
export const routeValue=(value: unknown)=>value===true?'启用':value===false?'关闭':value==null||value===''?'未设置':String(value)
export const emptyRoute=():RouteRule=>({id:'',path:'/proxy/**',uri:'',rewriteEnabled:true,rewriteRegex:'',rewriteReplacement:'/${segment}',circuitBreakerEnabled:true,circuitBreakerName:'',fallbackPath:'/fallback/default'})
