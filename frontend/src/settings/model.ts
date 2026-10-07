import type { RuntimeConfig } from '../stores/traffic'

export type NumericKey = Exclude<keyof RuntimeConfig, 'rateLimitEnabled'>
export type SettingsDraft = Record<NumericKey, string> & { rateLimitEnabled: boolean | null }
export const numericFields = [
  {key:'replenishRate',label:'令牌补充速率',unit:'令牌/秒',max:10000,group:'traffic',description:'每个 IP 的令牌桶每秒补充的令牌数。'},
  {key:'burstCapacity',label:'令牌桶容量',unit:'令牌',max:10000,group:'traffic',description:'每个 IP 最多可积累的令牌，用于应对短时突发。'},
  {key:'requestedTokens',label:'单次请求消耗',unit:'令牌/请求',max:100,group:'traffic',description:'每次请求需要扣除的令牌数；它会影响可通过的请求量。'},
  {key:'monitorWindowSeconds',label:'指标统计窗口',unit:'秒',max:120,group:'monitor',description:'QPS 与延迟统计所覆盖的最近时间窗口。'},
  {key:'emitIntervalSeconds',label:'快照推送间隔',unit:'秒',max:5,group:'monitor',description:'向运行概览推送一份流量快照的时间间隔。'}
] as const
export const fields = [{key:'rateLimitEnabled',label:'全局限流',unit:''},...numericFields] as const
export const emptyDraft = (): SettingsDraft => ({
  rateLimitEnabled:null,replenishRate:'',burstCapacity:'',requestedTokens:'',monitorWindowSeconds:'',emitIntervalSeconds:''
})
export function toDraft(config: RuntimeConfig): SettingsDraft {
  const draft = emptyDraft()
  draft.rateLimitEnabled = config.rateLimitEnabled
  for (const field of numericFields) draft[field.key] = String(config[field.key])
  return draft
}
export function validateDraft(draft: SettingsDraft) {
  const errors: Partial<Record<keyof RuntimeConfig,string>> = {}
  if (typeof draft.rateLimitEnabled !== 'boolean') errors.rateLimitEnabled = '尚未读取全局限流状态'
  for (const field of numericFields) {
    const raw = draft[field.key].trim()
    if (!raw) errors[field.key] = '请填写' + field.label
    else if (!/^\d+$/.test(raw)) errors[field.key] = '请输入整数，不支持小数或非数字'
    else if (!Number.isSafeInteger(Number(raw)) || Number(raw) < 1 || Number(raw) > field.max)
      errors[field.key] = '请输入 1–' + field.max.toLocaleString('en-US') + ' 之间的整数'
  }
  return errors
}
export function parseDraft(draft: SettingsDraft): RuntimeConfig | null {
  if (Object.keys(validateDraft(draft)).length) return null
  return {rateLimitEnabled:draft.rateLimitEnabled!,replenishRate:Number(draft.replenishRate),
    burstCapacity:Number(draft.burstCapacity),requestedTokens:Number(draft.requestedTokens),
    monitorWindowSeconds:Number(draft.monitorWindowSeconds),emitIntervalSeconds:Number(draft.emitIntervalSeconds)}
}
export function parseConfig(value: unknown): RuntimeConfig {
  if (!value || typeof value !== 'object') throw new Error('配置响应不完整，请重新读取确认')
  const config = value as RuntimeConfig
  if (typeof config.rateLimitEnabled !== 'boolean' ||
    numericFields.some(field => !Number.isInteger(config[field.key]) || config[field.key] < 1 || config[field.key] > field.max))
    throw new Error('配置响应不完整或超出支持范围，请重新读取确认')
  return {rateLimitEnabled:config.rateLimitEnabled,...Object.fromEntries(numericFields.map(f=>[f.key,config[f.key]]))} as RuntimeConfig
}
export function changedKeys(current: RuntimeConfig | null, draft: SettingsDraft): (keyof RuntimeConfig)[] {
  if (!current) return []
  const errors = validateDraft(draft)
  return fields.filter(field => field.key === 'rateLimitEnabled'
    ? draft.rateLimitEnabled !== current.rateLimitEnabled
    : !!errors[field.key] || Number(draft[field.key]) !== current[field.key]).map(field=>field.key)
}
export function sameConfig(a: RuntimeConfig, b: RuntimeConfig) { return fields.every(field=>a[field.key] === b[field.key]) }
export function displayValue(value: string | number | boolean | null | undefined) {
  return value == null ? '—' : typeof value === 'boolean' ? value ? '开启' : '关闭' :
    typeof value === 'number' ? value.toLocaleString('en-US') : value.trim() || '未填写'
}

// Versions are opaque on the wire; decimal suffix parsing only validates this protocol.
export interface VersionedConfig extends RuntimeConfig { version:string }
export interface ConfigResponse extends VersionedConfig { source:'redis'; confirmation:'read'|'committed'; adopted:VersionedConfig }
export function parseSnapshot(value: unknown): VersionedConfig {
  const config = parseConfig(value), version = (value as {version?:unknown}).version
  if (typeof version !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[1-9][0-9]{0,15}$/.test(version) ||
    !Number.isSafeInteger(Number(version.slice(37)))) throw new Error('配置版本缺失或非法，请升级调用方并重新读取')
  return {...config,version}
}
export function parseResponse(value: unknown, confirmation:'read'|'committed'): ConfigResponse {
  const snapshot = parseSnapshot(value), response = value as ConfigResponse
  if (response.source !== 'redis' || response.confirmation !== confirmation) throw new Error('配置确认来源不完整，请重新读取')
  return {...snapshot,source:'redis',confirmation,adopted:parseSnapshot(response.adopted)}
}
