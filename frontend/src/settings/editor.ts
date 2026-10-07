import { computed, reactive } from 'vue'
import { defineStore } from 'pinia'
import { parseReceipt, parseHistory, parseRollbackPreview, isRollback, type SubmissionRequest, type OperationRequest, type RollbackRequest, type HistoryReference, type RollbackPreview, type OperationReceipt } from './operations'
import { ApiError, apiRequest, errorMessage } from '../api'
import type { RuntimeConfig } from '../stores/traffic'
import { changedKeys, emptyDraft, fields, parseResponse, parseSnapshot, parseDraft, sameConfig, toDraft, validateDraft, type SettingsDraft, type VersionedConfig } from './model'

export interface SettingsClient {
  read(signal: AbortSignal): Promise<unknown>
  write(value: SubmissionRequest): Promise<unknown>
  query?(operationId:string, signal:AbortSignal): Promise<unknown>
  history?(cursor:string, signal:AbortSignal): Promise<unknown>
  previewRollback?(source:HistoryReference, signal:AbortSignal): Promise<unknown>
  rollback?(request:RollbackRequest): Promise<unknown>
}
type WriteStatus = 'idle' | 'confirmed' | 'rejected' | 'uncertain' | 'reconciled' | 'conflict' | 'committed-unadopted'
type RemoteChange = {key:keyof RuntimeConfig,before:number|boolean,latest:number|boolean}
export function createSettingsEditor(client: SettingsClient) {
  const state = reactive({
    current:null as VersionedConfig|null, adopted:null as VersionedConfig|null, draft:emptyDraft(), loading:false, saving:false,
    loadedAt:null as number|null, savedAt:null as number|null, readError:'',
    writeStatus:'idle' as WriteStatus, writeMessage:'', needsConfirmation:false, authExpired:false,
    reviewRequired:false, reviewBaseline:null as VersionedConfig|null, remoteChanges:[] as RemoteChange[], submittedVersion:'',
    operation:null as OperationRequest|null, operationStatus:'' as ''|'unknown'|'committed'|'rejected'|'abandoned',
    receipt:null as OperationReceipt|null, querying:false, operationMessage:'',
    historyOpen:false, historyLoading:false, historyError:'', historyEntries:[] as OperationReceipt[], historyCursor:'',
    historyNextCursor:null as string|null, historyCheckedAt:null as number|null,
    rollbackSource:null as HistoryReference|null, rollbackPreview:null as RollbackPreview|null,
    rollbackLoading:false, rollbackError:'', rollbackReviewed:false,
    serverErrors:{} as Partial<Record<keyof RuntimeConfig,string>>
  })
  let reading: AbortController|undefined, generation = 0
  let querying: AbortController|undefined, queryGeneration = 0
  let historyReading:AbortController|undefined, historyGeneration=0, previewReading:AbortController|undefined, previewGeneration=0
  const historySupported=!!client.history && !!client.previewRollback && !!client.rollback
  const changes = computed(()=>changedKeys(state.current,state.draft))
  const errors = computed(()=>state.current ? {...validateDraft(state.draft),...state.serverErrors} : {})
  const dirty = computed(()=>changes.value.length > 0)
  const protectedDraft = computed(()=>dirty.value || state.needsConfirmation || state.saving || state.reviewRequired || !!state.rollbackSource)
  const canSave = computed(()=>!!state.current && dirty.value && !Object.keys(errors.value).length &&
    !state.loading && !state.saving && !state.querying && !state.needsConfirmation && !state.reviewRequired && !state.readError && !state.authExpired && !state.rollbackSource)
  const canRollback=computed(()=>historySupported && !!state.rollbackPreview && state.rollbackReviewed &&
    state.rollbackPreview.current.version===state.current?.version && !state.rollbackLoading && !state.historyLoading &&
    !state.rollbackError && !state.loading && !state.saving && !state.querying && !state.needsConfirmation && !state.readError && !state.authExpired)
  function cancelHistoryReads() {
    historyGeneration++;historyReading?.abort();historyReading=undefined;state.historyLoading=false
    previewGeneration++;previewReading?.abort();previewReading=undefined;state.rollbackLoading=false
  }
  async function loadHistory(cursor='') {
    if(!client.history || state.saving)return
    const at=++historyGeneration,controller=new AbortController()
    historyReading?.abort();historyReading=controller;state.historyLoading=true;state.historyOpen=true;state.historyError=''
    try {
      const page=parseHistory(await client.history(cursor,controller.signal))
      if(at!==historyGeneration)return
      state.historyEntries=page.entries;state.historyCursor=cursor;state.historyNextCursor=page.nextCursor;state.historyCheckedAt=page.checkedAt
    } catch(error) {
      if(at!==historyGeneration)return
      state.historyError=errorMessage(error)
      if(error instanceof ApiError && error.status===401)state.authExpired=true
    } finally {if(at===historyGeneration){state.historyLoading=false;historyReading=undefined}}
  }
  async function previewRollback(source:HistoryReference) {
    if(!client.previewRollback || state.saving || state.querying || state.loading || state.operationStatus==='unknown')return
    const at=++previewGeneration,controller=new AbortController()
    previewReading?.abort();previewReading=controller
    state.rollbackSource={...source};state.rollbackPreview=null;state.rollbackReviewed=false;state.rollbackLoading=true;state.rollbackError=''
    try {
      const preview=parseRollbackPreview(await client.previewRollback(source,controller.signal),source)
      if(at!==previewGeneration)return
      rebase(preview.current,state.reviewRequired)
      state.adopted=preview.adopted;state.readError='';state.authExpired=false
      state.needsConfirmation=preview.current.version!==preview.adopted.version
      state.rollbackPreview=preview
    } catch(error) {
      if(at!==previewGeneration)return
      state.rollbackError=errorMessage(error)
      if(error instanceof ApiError && error.status===401)state.authExpired=true
    } finally {if(at===previewGeneration){state.rollbackLoading=false;previewReading=undefined}}
  }
  function closeHistory() {
    if(state.saving || state.querying || state.operationStatus==='unknown')return
    cancelHistoryReads();state.historyOpen=false;state.rollbackSource=null;state.rollbackPreview=null;state.rollbackError='';state.rollbackReviewed=false
  }
  function edit<K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) {
    if (!state.current || state.loading || state.saving) return
    state.draft[key] = value
    delete state.serverErrors[key]
  }
  function acknowledgeReview() {
    if (state.loading || state.saving || state.needsConfirmation || state.readError || state.authExpired) return
    resetReview()
  }
  function resetReview() {
    state.reviewRequired = false; state.reviewBaseline = null; state.remoteChanges = []
  }
  function restore() {
    if (!state.current || state.loading || state.saving || state.needsConfirmation) return
    state.draft = toDraft(state.current); state.serverErrors = {}; resetReview()
    if (['rejected','conflict'].includes(state.writeStatus)) { state.writeStatus = 'idle'; state.writeMessage = '' }
  }
  function cancelRead() { generation++; reading?.abort(); reading = undefined; state.loading = false }
  function clear() {
    if (state.saving) return
    // Explicit discard ends the query's ownership of this editor. Authentication unmounts
    // only cancelRead(), so they retain the operation and draft for recovery.
    queryGeneration++; querying?.abort(); querying = undefined
    cancelRead();cancelHistoryReads()
    Object.assign(state,{current:null,adopted:null,draft:emptyDraft(),loadedAt:null,savedAt:null,readError:'',
      writeStatus:'idle',writeMessage:'',needsConfirmation:false,authExpired:false,serverErrors:{},
      reviewRequired:false,reviewBaseline:null,remoteChanges:[],submittedVersion:'',
      operation:null,operationStatus:'',receipt:null,querying:false,operationMessage:'',
      historyOpen:false,historyLoading:false,historyError:'',historyEntries:[],historyCursor:'',historyNextCursor:null,historyCheckedAt:null,
      rollbackSource:null,rollbackPreview:null,rollbackLoading:false,rollbackError:'',rollbackReviewed:false})
  }
  function rebase(current: VersionedConfig, requireReview: boolean) {
    if (state.current && current.version.slice(0,37)===state.current.version.slice(0,37) &&
      Number(current.version.slice(37))<Number(state.current.version.slice(37)))
      throw new Error('读取结果早于已确认版本；保留当前基准，请重新读取')
    const previous = state.current, previousChanges = changes.value.slice(), draft = {...state.draft}
    const reviewRequired = state.reviewRequired || requireReview ||
      (previousChanges.length > 0 && !!previous && previous.version !== current.version)
    // A fresh read advances the CAS version, but cannot acknowledge earlier remote changes.
    if (reviewRequired && !state.reviewBaseline && previous) state.reviewBaseline = parseSnapshot(previous)
    const baseline = state.reviewBaseline
    state.remoteChanges = baseline ? fields.filter(f=>baseline[f.key]!==current[f.key])
      .map(f=>({key:f.key,before:baseline[f.key],latest:current[f.key]})) : []
    const rebased = toDraft(current)
    // Carry only actual user edits, never the untouched remainder of a stale form.
    for (const key of previousChanges) Object.assign(rebased,{[key]:draft[key]})
    if(state.rollbackPreview && state.rollbackPreview.current.version!==current.version)state.rollbackReviewed=false
    state.current = current; state.draft = rebased
    state.reviewRequired = reviewRequired
    state.loadedAt = Date.now(); state.serverErrors = {}
  }
  async function load() {
    if (state.loading || state.saving) return
    const generationAtRead = ++generation, controller = new AbortController()
    reading = controller; state.loading = true
    const verifying = state.needsConfirmation, review = state.reviewRequired, verificationStatus = state.writeStatus
    try {
      const response = parseResponse(await client.read(controller.signal), 'read')
      if (generationAtRead !== generation) return
      rebase(response, review || (verifying && dirty.value))
      state.adopted = response.adopted
      state.readError = ''; state.authExpired = false
      state.needsConfirmation = response.version !== response.adopted.version || state.operationStatus==='unknown'
      if (state.needsConfirmation) {
        state.writeMessage = state.operationStatus==='unknown'
          ? '已读取当前配置，但不能证明原提交是否执行；请查询本次提交结果，草稿与操作 ID 已保留。'
          : '此次存储读取与本实例已采用版本不同；保留草稿，请再次读取核对。'
      } else if (verifying) {
        const desired = parseDraft(state.draft)
        const matches = desired && sameConfig(response,desired)
        state.writeStatus = verificationStatus==='confirmed' ? 'confirmed' : 'reconciled'
        state.writeMessage = verificationStatus==='uncertain'
          ? matches ? '已读取确认：存储当前值与草稿一致。此读取不能证明原提交是否执行。'
            : '已读取存储当前版本；仍有差异的草稿已保留。原提交是否执行仍无法据此确认，请核对后再保存。'
          : ['confirmed','committed-unadopted'].includes(verificationStatus)
            ? '此前存储写入已确认；现在已读取当前存储与本实例采用版本。' + (matches ? '' : '新的草稿差异已保留，请核对。')
            : '已读取存储当前版本与本实例采用值；保留草稿，请核对后再保存。'
        if (!dirty.value && !review) resetReview()
      }
    } catch (error) {
      if (generationAtRead !== generation) return
      state.readError = errorMessage(error)
      if (error instanceof ApiError && error.details?.code==='CONFIG_ADOPTION_FAILED') {
        try {
          const confirmed = parseSnapshot(error.details.confirmed), adopted = parseSnapshot(error.details.adopted)
          rebase(confirmed, true); state.adopted = adopted
        } catch { /* Retain the last valid baseline if error metadata is incomplete. */ }
        state.needsConfirmation = true
      }
      if (error instanceof ApiError && error.status === 401) {
        state.authExpired = true
        if (state.current) state.needsConfirmation = true
      }
    } finally {
      if (generationAtRead === generation) { state.loading = false; reading = undefined }
    }
  }
  async function save() {
    if (!canSave.value) return
    const submitted=parseDraft(state.draft)!,expectedVersion=state.current!.version
    await submit(submitted,{...submitted,expectedVersion,operationId:crypto.randomUUID()})
  }
  async function rollback() {
    if(!canRollback.value || !state.rollbackPreview)return
    const preview=state.rollbackPreview
    await submit(preview.target,{operationType:'rollback',expectedVersion:preview.current.version,operationId:crypto.randomUUID(),
      source:{version:preview.source.version,operationId:preview.source.operationId}})
  }
  async function submit(submitted:RuntimeConfig,operation:OperationRequest) {
    const expectedVersion=operation.expectedVersion, restoring=isRollback(operation)
    state.submittedVersion = expectedVersion
    state.operation = operation
    state.rollbackReviewed=false
    state.operationStatus = 'unknown'; state.receipt = null; state.operationMessage = '' 
    state.saving = true; state.writeMessage = ''; state.serverErrors = {}
    try {
      const raw = await (isRollback(operation) ? client.rollback!(operation) : client.write(operation))
      const returned = parseResponse(raw, 'committed')
      const receipt = parseReceipt((raw as {receipt?:unknown}).receipt,state.operation)
      if(receipt.status!=='committed') throw new Error('缺少成功回执')
      state.receipt=receipt; state.operationStatus='committed'
      state.operationMessage='原提交已成功 · '+receipt.after!.version
      if (returned.version !== expectedVersion.slice(0,37)+(Number(expectedVersion.slice(37))+1))
        throw new Error('保存响应的版本不属于本次提交，请读取核对')
      state.current = returned; state.adopted = returned.adopted; state.draft = toDraft(returned)
      state.loadedAt = state.savedAt = Date.now()
      state.writeStatus = 'confirmed'; state.needsConfirmation = returned.version !== returned.adopted.version
      state.readError = ''; resetReview()
      if(restoring){state.rollbackSource=null;state.rollbackPreview=null;state.rollbackError=''}
      state.writeMessage = state.needsConfirmation
        ? '本次提交已获存储确认；本实例已采用另一个版本，请重新读取核对当前配置。'
        : sameConfig(returned,submitted)
          ? restoring ? '历史恢复已确认，六项参数已作为新版本提交；其他实例通过后台同步采用。' : '保存已确认，存储与本实例已采用本次版本。'
          : '保存已确认；服务端返回值与提交内容不同，已按返回值更新。'
    } catch (error) {
      const details = error instanceof ApiError ? error.details : undefined
      if(restoring && error instanceof ApiError && details?.code==='CONFIG_VERSION_CONFLICT')
        state.rollbackError='核对期间配置已更新。恢复目标已保留；请重新读取恢复预览，核对后明确再次提交。'
      if(restoring && error instanceof ApiError && details?.code==='CONFIG_HISTORY_UNAVAILABLE') {
        state.rollbackError=errorMessage(error);state.rollbackPreview=null
      }
      if (error instanceof ApiError && error.status === 409 && details?.code === 'CONFIG_VERSION_CONFLICT') {
        try {
          const current = parseSnapshot(details.current)
          const adopted = parseSnapshot(details.adopted)
          rebase(current, true); state.adopted = adopted
          state.operationStatus='rejected'
          state.writeStatus = 'conflict'; state.readError = ''
          state.needsConfirmation = current.version !== adopted.version
          state.writeMessage = '版本冲突：本次未写入。你的修改已保留，未修改字段已更新；请核对最新值后明确再次提交。'
          return
        } catch {
          state.operationStatus='rejected'
          state.writeStatus = 'conflict'; state.needsConfirmation = true
          state.writeMessage = '版本冲突：本次未写入，但最新配置响应不完整。草稿已保留，请重新读取核对。'
          return
        }
      }
      const definite = error instanceof ApiError && (details?.outcome === 'not-written' ||
        [400,401,403,404,405,410,415,422,428,429].includes(error.status))
      const committed = details?.outcome === 'committed'
      state.operationStatus = committed ? 'committed' : definite ? 'rejected' : 'unknown'
      state.writeStatus = committed ? 'committed-unadopted' : definite ? 'rejected' : 'uncertain'
      state.writeMessage = committed
        ? '存储已确认本次写入，但本实例未能采用。草稿保留，请读取核对并检查实例状态。'
        : definite ? '保存被拒绝，草稿已保留。' + errorMessage(error)
          : '未收到可靠的保存确认，服务端可能已写入。请查询本次提交结果，草稿与操作 ID 已保留。' + errorMessage(error)
      state.needsConfirmation = committed || !definite
      if (committed) {
        try {
          const confirmed = parseSnapshot(details?.confirmed), adopted = parseSnapshot(details?.adopted)
          rebase(confirmed, true); state.adopted = adopted
        } catch { /* The outcome remains committed even if its value metadata needs rereading. */ }
      }
      if (error instanceof ApiError && error.field && fields.some(field=>field.key === error.field))
        state.serverErrors[error.field as keyof RuntimeConfig] = errorMessage(error)
      if (error instanceof ApiError && error.status === 401) {
        state.authExpired = true; state.needsConfirmation = true
      }
    } finally { state.saving = false }
  }
  async function queryOperation() {
    if (!state.operation || !client.query || state.querying || state.saving || state.loading) return
    const submitted={...state.operation}, generationAtQuery=++queryGeneration, controller=new AbortController()
    querying=controller
    state.querying=true; state.operationMessage='正在查询原提交…'
    let refresh=false
    try {
      const result=await client.query(submitted.operationId,controller.signal) as {status?:string;receipt?:unknown;adopted?:unknown}
      if(generationAtQuery!==queryGeneration) return
      if(result.status==='unknown') {
        state.operationMessage=state.receipt
          ? '当前无可用回执；此前已确认的原提交结果仍保留：'+(state.receipt.status==='committed' ? '成功 · '+state.receipt.after!.version : '版本冲突，未写入')
          : state.operationStatus==='rejected' ? '未取得持久回执；此前本次请求已被明确拒绝，查询没有提供新增证据。'
          : state.operationStatus==='committed' ? '未取得持久回执；此前本次写入已获确认，当前采用情况需另行核对。'
          : '没有可用回执，原提交仍无法确认；可能尚未执行、回执过期或已丢失。不会自动重发。'
        return
      }
      const receipt=parseReceipt(result.receipt,submitted)
      if(result.status!==receipt.status) throw new Error('回执状态不一致')
      if(state.receipt && state.receipt.recordedAt!==receipt.recordedAt)
        throw new Error('回执已不属于此前记录的有效窗口，保留已有结果')
      state.receipt=receipt; state.operationStatus=receipt.status
      if(isRollback(submitted) && receipt.status==='committed') {
        state.rollbackSource=null;state.rollbackPreview=null;state.rollbackError='';state.rollbackReviewed=false
      }
      state.authExpired=false
      // This is a historical fact. It must NEVER become the editor's current baseline.
      state.operationMessage=receipt.status==='committed'
        ? '原提交已成功 · '+receipt.after!.version+'。当前实例采用情况单独显示。'
        : '原提交被版本检查拒绝，未写入。请读取最新配置并核对草稿。'
      state.writeStatus=receipt.status==='committed' ? 'confirmed' : 'conflict'
      state.needsConfirmation=true
      if(result.adopted) state.adopted=parseSnapshot(result.adopted)
      refresh=true
    } catch(error) {
      if(generationAtQuery!==queryGeneration) return
      state.operationMessage=(state.receipt ? '回执重新查询失败；此前已确认的操作结果仍保留。' : '原提交仍无法确认。')+errorMessage(error)
      if(error instanceof ApiError && error.status===401) state.authExpired=true
    } finally {
      if(generationAtQuery===queryGeneration) {state.querying=false; querying=undefined}
    }
    if(refresh && generationAtQuery===queryGeneration) await load()
  }
  function finishUnknown() {
    if(state.operationStatus!=='unknown' || state.loading || state.saving || state.querying || state.authExpired ||
      state.readError || !state.current || state.current.version!==state.adopted?.version) return
    // Only the explicit UI confirmation calls this. No write is scheduled.
    state.operationStatus='abandoned'; state.needsConfirmation=false; state.reviewRequired=true
    state.operationMessage='已结束确认；原提交结果仍未知。再次保存将使用新操作 ID，请先核对当前值。'
  }
  return {state,changes,errors,dirty,protectedDraft,canSave,historySupported,canRollback,loadHistory,previewRollback,rollback,closeHistory,cancelHistoryReads,edit,restore,load,save,cancelRead,clear,acknowledgeReview,queryOperation,finishUnknown}
}
export type SettingsEditor = ReturnType<typeof createSettingsEditor>
export const useSettingsStore = defineStore('settings-editor',()=>createSettingsEditor({
  read: signal=>apiRequest('/settings/runtime',{signal:AbortSignal.any([signal,AbortSignal.timeout(10000)])}),
  write: value=>apiRequest('/settings/runtime',{method:'PUT',body:JSON.stringify(value)}),
  query: (id,signal)=>apiRequest('/settings/runtime/operations/'+encodeURIComponent(id),{signal:AbortSignal.any([signal,AbortSignal.timeout(10000)])}),
  history: (cursor,signal)=>apiRequest('/settings/runtime/history?limit=20&cursor='+encodeURIComponent(cursor),{signal:AbortSignal.any([signal,AbortSignal.timeout(10000)])}),
  previewRollback: (source,signal)=>apiRequest('/settings/runtime/rollback-preview?sourceVersion='+encodeURIComponent(source.version)+'&sourceOperationId='+encodeURIComponent(source.operationId),{signal:AbortSignal.any([signal,AbortSignal.timeout(10000)])}),
  rollback: request=>apiRequest('/settings/runtime/rollback',{method:'PUT',body:JSON.stringify({operationId:request.operationId,expectedVersion:request.expectedVersion,source:request.source})})
}))
