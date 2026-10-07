import {parseSnapshot, parseConfig, sameConfig, type VersionedConfig} from './model'
import type {RuntimeConfig} from '../stores/traffic'

export interface HistoryReference {version:string;operationId:string}
export interface RecordedSource extends HistoryReference {recordedAt:number}
export type SubmissionRequest = RuntimeConfig & {expectedVersion:string;operationId:string}
export interface RollbackRequest {operationType:'rollback';expectedVersion:string;operationId:string;source:HistoryReference}
export type OperationRequest = SubmissionRequest | RollbackRequest
export interface OperationReceipt {
  operationType:'update'|'rollback'; source?:RecordedSource;
  operationId:string; expectedVersion:string; status:'committed'|'rejected'; instanceId:string;
  recordedAt:number; expiresAt:number; request:RuntimeConfig; before:VersionedConfig; after?:VersionedConfig
}
export interface RollbackPreview {
  current:VersionedConfig;target:VersionedConfig;adopted:VersionedConfig;source:RecordedSource;checkedAt:number;noChanges:boolean
}
export function isRollback(request:OperationRequest):request is RollbackRequest {return 'operationType' in request && request.operationType==='rollback'}
export function sameSource(a:HistoryReference,b:HistoryReference) {return a.version===b.version && a.operationId===b.operationId}
function parseSource(value:unknown):RecordedSource {
  if(!value || typeof value!=='object')throw new Error('恢复来源不完整')
  const source=value as RecordedSource
  if(typeof source.operationId!=='string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(source.operationId) ||
    !Number.isSafeInteger(source.recordedAt) || source.recordedAt<1)throw new Error('恢复来源不完整')
  return {version:source.version,operationId:source.operationId,recordedAt:source.recordedAt}
}
export function parseReceipt(value:unknown, submitted:OperationRequest):OperationReceipt {
  if (!value || typeof value!=='object') throw new Error('提交回执不完整')
  // Existing schema-2 normal-update responses remain readable during a coordinated client upgrade.
  const raw=value as OperationReceipt, r={...raw,operationType:raw.operationType??'update'}
  const rollback=isRollback(submitted),request=parseConfig(r.request)
  if (r.operationId!==submitted.operationId || r.expectedVersion!==submitted.expectedVersion ||
    r.operationType!==(rollback?'rollback':'update') || (!rollback && !sameConfig(request,submitted)) ||
    !['committed','rejected'].includes(r.status) || !Number.isSafeInteger(r.recordedAt) ||
    !Number.isSafeInteger(r.expiresAt) || r.expiresAt<=r.recordedAt ||
    typeof r.instanceId!=='string' || !r.instanceId) throw new Error('回执与原提交不匹配')
  if(rollback) {
    r.source=parseSource(r.source)
    parseSnapshot({...request,version:r.source.version})
    if(!sameSource(r.source,submitted.source) || r.source.recordedAt>r.recordedAt)throw new Error('回执恢复来源与原提交不匹配')
  }
  const before=parseSnapshot(r.before)
  if(r.status==='committed') {
    const after=parseSnapshot(r.after)
    if(before.version!==submitted.expectedVersion ||
      after.version!==before.version.slice(0,37)+(Number(before.version.slice(37))+1) || !sameConfig(after,request))
      throw new Error('成功回执的版本或内容不完整')
    return {...r,before,after,request}
  }
  return {...r,before,request}
}
export function parseHistory(value:unknown):{entries:OperationReceipt[];nextCursor:string|null;checkedAt:number} {
  const page=value as {entries?:unknown;nextCursor?:unknown;checkedAt?:unknown;source?:unknown}
  if(!page || page.source!=='redis-history' || !Array.isArray(page.entries) || page.entries.length>50 ||
    !Number.isSafeInteger(page.checkedAt) || (page.nextCursor!==null && typeof page.nextCursor!=='string'))throw new Error('历史响应不完整')
  const entries=page.entries.map(value=>{
    const r=value as OperationReceipt
    const submitted:OperationRequest=r.operationType==='rollback'
      ? {operationType:'rollback',source:parseSource(r.source),operationId:r.operationId,expectedVersion:r.expectedVersion}
      : {...parseConfig(r.request),operationId:r.operationId,expectedVersion:r.expectedVersion}
    const receipt=parseReceipt(value,submitted)
    if(receipt.status!=='committed' || !receipt.after)throw new Error('历史包含非成功提交')
    return receipt
  })
  for(let i=1;i<entries.length;i++)if(Number(entries[i].after!.version.slice(37))>=Number(entries[i-1].after!.version.slice(37)))throw new Error('历史顺序非法')
  return {entries,nextCursor:page.nextCursor as string|null,checkedAt:page.checkedAt as number}
}
export function parseRollbackPreview(value:unknown,reference:HistoryReference):RollbackPreview {
  const raw=value as RollbackPreview & {origin?:string}
  if(!raw || raw.origin!=='redis-history' || !Number.isSafeInteger(raw.checkedAt))throw new Error('恢复预览来源不完整')
  const current=parseSnapshot(raw.current),target=parseSnapshot(raw.target),adopted=parseSnapshot(raw.adopted),source=parseSource(raw.source)
  if(!sameSource(source,reference) || source.version!==target.version || raw.noChanges!==sameConfig(current,target))throw new Error('恢复预览与来源不匹配')
  return {current,target,adopted,source,checkedAt:raw.checkedAt,noChanges:raw.noChanges}
}
