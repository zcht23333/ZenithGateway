import { ApiError } from '../api'
import { createSettingsEditor } from './editor'
import type { RuntimeConfig } from '../stores/traffic'

export const settingsScenes = [
  {id:'normal',label:'正常'}, {id:'conflict',label:'版本冲突'}, {id:'read-failure',label:'首次读取失败'}, {id:'rejected',label:'保存被拒绝'},
  {id:'uncertain',label:'保存响应中断'}, {id:'saved-read-failure',label:'保存后读取失败'},
  {id:'disabled',label:'限流关闭'}, {id:'loading',label:'首次读取中'}
] as const
export function settingsScene(value: unknown) { return settingsScenes.find(scene=>scene.id===value)?.id ?? 'normal' }
export type SettingsScene = ReturnType<typeof settingsScene>
const initial: RuntimeConfig = {rateLimitEnabled:true,replenishRate:20,burstCapacity:40,requestedTokens:1,monitorWindowSeconds:10,emitIntervalSeconds:1}
export function createSettingsPreview(scene: SettingsScene) {
  let current = {...initial,rateLimitEnabled:scene!=='disabled'}, reads = 0, writes = 0, readFailure = false
  let revision = 1
  const receipts=new Map<string,unknown>()
  const snapshot = () => ({...current,version:'00000000-0000-0000-0000-000000000001:'+revision})
  const response = (confirmation:'read'|'committed') => ({...snapshot(),source:'redis',confirmation,adopted:snapshot()})
  const wait = (ms:number,signal?:AbortSignal) => new Promise<void>((resolve,reject)=>{
    const done = ()=>{signal?.removeEventListener('abort',abort);resolve()}
    const timer = setTimeout(done,ms)
    function abort(){clearTimeout(timer);reject(new Error('读取已取消'))}
    if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true})
  })
  return createSettingsEditor({
    async read(signal) {
      reads++; await wait(scene==='loading' && reads===1 ? 8000 : 180,signal)
      if ((scene==='read-failure' && reads===1) || readFailure) {
        readFailure = false; throw new ApiError('演示：配置暂不可读取（HTTP 503）',503)
      }
      return response('read')
    },
    async write(value) {
      writes++; await wait(850)
      if (scene==='rejected' && writes===1) throw new ApiError('演示：当前连接没有配置写入权限（HTTP 403）',403)
      if (scene==='conflict' && writes===1) {
        current = {...current,monitorWindowSeconds:30}; revision++
        throw new ApiError('演示：另一个管理端已修改统计窗口',409,undefined,
          {code:'CONFIG_VERSION_CONFLICT',outcome:'not-written',current:snapshot(),adopted:snapshot()})
      }
      const before=snapshot()
      const {expectedVersion,operationId,...values} = value
      current = {...values}; revision++
      const recordedAt=Date.now(), receipt={operationId,expectedVersion,request:values,before,after:snapshot(),
        recordedAt,expiresAt:recordedAt+86400000,instanceId:'00000000-0000-0000-0000-000000000001',status:'committed'}
      receipts.set(operationId,receipt)
      if (scene==='uncertain' && writes===1) throw new Error('演示：保存响应在返回途中断开。')
      if (scene==='saved-read-failure') readFailure = true
      return {...response('committed'),receipt}
    },
    async query(id) {return receipts.has(id) ? {status:'committed',receipt:receipts.get(id),adopted:snapshot()} : {status:'unknown'}}
  })
}
