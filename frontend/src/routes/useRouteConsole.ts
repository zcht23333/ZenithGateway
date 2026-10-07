import { onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { apiRequest, errorMessage } from '../api'
import { parsePublication, type RoutePublication, type RouteDiagnostics } from './publication'
import type { RouteRule, RuntimeConfig, TrafficMetricsSnapshot, AuditStatus } from '../stores/traffic'
import { previewRoutes, previewConfig, previewSnapshot, previewAudit, type PreviewScenario } from './preview'

export function useRouteConsole(preview: Ref<boolean>, scenario: Ref<PreviewScenario>) {
  const rows = ref<RouteRule[]>([])
  const publication = ref<RoutePublication|null>(null), diagnostics = ref<RouteDiagnostics|null>(null), diagnosticsError = ref('')
  const config = ref<RuntimeConfig | null>(null)
  const snapshot = ref<TrafficMetricsSnapshot | null>(null)
  const audit = ref<AuditStatus | null>(null)
  const routeError = ref('')
  const metricsError = ref('')
  const configError = ref('')
  const auditError = ref('')
  const loading = ref(false)
  const globalsLoading = ref(false)
  const saving = ref(false)
  const loadedAt = ref<number | null>(null)
  const notice = ref('')
  const noticeKind = ref<'success' | 'warning'>('success')
  let version = 0
  let controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let diagnosticTimer: ReturnType<typeof setTimeout> | undefined

  function request<T>(path: string, init: RequestInit = {}) {
    return apiRequest<T>(path, { ...init,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) })
  }
  function loadPreview() {
    rows.value = previewRoutes(scenario.value)
    config.value = { ...previewConfig }
    snapshot.value = { ...previewSnapshot }
    audit.value = { ...previewAudit }
    loadedAt.value = previewSnapshot.timestamp
    routeError.value = scenario.value === 'exception' ? '路由配置读取失败（HTTP 503）' : ''
    if (scenario.value === 'exception') {
      audit.value = { ...previewAudit, pending: 128, queueDepth: 112, inFlight: 16,
        persisted: previewAudit.received - 128, oldestAgeMs: 2300 }
    }
  }
  async function refreshRoutes() {
    if (loading.value) return
    if (preview.value) {
      routeError.value = ''
      notice.value = '演示：配置读取已恢复，当前修改仅保留在本页。'
      noticeKind.value = 'success'
      return
    }
    const expected = version
    loading.value = true
    try {
      const result = parsePublication(await request('/settings/routes'))
      if (expected !== version) return
      rows.value = result.routes
      publication.value = result
      loadedAt.value = Date.now()
      routeError.value = ''
    } catch (error) {
      if (expected === version) routeError.value = errorMessage(error)
    } finally { if (expected === version) loading.value = false }
  }
  async function refreshGlobals() {
    if (preview.value || globalsLoading.value) return
    clearTimeout(timer)
    const expected = version
    globalsLoading.value = true
    const results = await Promise.allSettled([
      request<RuntimeConfig>('/settings/runtime'),
      request<TrafficMetricsSnapshot>('/dashboard/snapshot'),
      request<AuditStatus>('/monitor/audit/status')
    ])
    if (expected !== version) return
    globalsLoading.value = false
    const [settings, traffic, status] = results
    if (settings.status === 'fulfilled') { config.value = settings.value; configError.value = '' }
    else { config.value = null; configError.value = errorMessage(settings.reason) }
    if (traffic.status === 'fulfilled') { snapshot.value = traffic.value; metricsError.value = '' }
    else { snapshot.value = null; metricsError.value = errorMessage(traffic.reason) }
    if (status.status === 'fulfilled') { audit.value = status.value; auditError.value = '' }
    else { audit.value = null; auditError.value = errorMessage(status.reason) }
    timer = setTimeout(() => void refreshGlobals(), 5000)
  }
  async function refreshDiagnostics() {
    if(preview.value)return
    clearTimeout(diagnosticTimer)
    const expected=version
    try {const value=await request<RouteDiagnostics>('/settings/routes/diagnostics');if(expected!==version)return;diagnostics.value=value;diagnosticsError.value=''}
    catch(error){if(expected!==version)return;diagnosticsError.value=errorMessage(error)}
    if(expected===version)diagnosticTimer=setTimeout(()=>void refreshDiagnostics(),2000)
  }
  function restart() {
    version++
    controller.abort()
    controller = new AbortController()
    clearTimeout(timer)
    clearTimeout(diagnosticTimer)
    publication.value = null; diagnostics.value = null; diagnosticsError.value = ''
    rows.value = []
    config.value = null
    snapshot.value = null
    audit.value = null
    routeError.value = metricsError.value = configError.value = auditError.value = notice.value = ''
    loadedAt.value = null
    loading.value = false
    globalsLoading.value = false
    saving.value = false
    if (preview.value) loadPreview()
    else { void refreshRoutes(); void refreshGlobals(); void refreshDiagnostics() }
  }
  watch([preview, scenario], restart, { immediate: true })

  async function saveRoute(input: RouteRule): Promise<RouteRule> {
    if(!preview.value)throw new Error('正式路由发布需使用版本化编辑器。')
    if (saving.value || loading.value || routeError.value) throw new Error('请先完成配置读取，再保存路由。')
    saving.value = true
    const expected = version
    try {
      let saved: RouteRule
      if (preview.value) {
        const id = input.id.trim() || 'route-' + crypto.randomUUID()
        saved = { ...input, id, circuitBreakerName: input.circuitBreakerName.trim() || 'cb-' + id,
          rewriteRegex: input.rewriteRegex?.trim() || (input.rewriteEnabled ? '^\\Q' + input.path.slice(0, -3).replace(/\\E/g, '\\E\\\\E\\Q') + '\\E/(?<segment>.*)$' : ''),
          rewriteReplacement: input.rewriteReplacement || '/${segment}', fallbackPath: '/fallback/default' }
        rows.value = [...rows.value.filter(row => row.id !== id), saved].sort((a,b) => a.id.localeCompare(b.id))
      } else { throw new Error('请使用版本化编辑器') }
      notice.value = (preview.value ? '演示路由已保存。' : '路由已保存。') +
        (routeError.value ? '列表刷新失败，请重试读取。' : '')
      noticeKind.value = routeError.value ? 'warning' : 'success'
      return saved
    } finally { if (expected === version) saving.value = false }
  }
  async function deleteRoute(id: string) {
    if(!preview.value)throw new Error('正式路由发布需使用版本化编辑器。')
    if (saving.value || loading.value || routeError.value) throw new Error('请先完成配置读取，再删除路由。')
    saving.value = true
    const expected = version
    try {
      if (preview.value) rows.value = rows.value.filter(row => row.id !== id)
      notice.value = (preview.value ? '演示路由已删除。' : '路由已删除。') +
        (routeError.value ? '列表刷新失败，请重试读取。' : '')
      noticeKind.value = routeError.value ? 'warning' : 'success'
    } finally { if (expected === version) saving.value = false }
  }
  onBeforeUnmount(() => { version++; controller.abort(); clearTimeout(timer); clearTimeout(diagnosticTimer) })
  return { rows, publication, diagnostics, diagnosticsError, refreshDiagnostics, config, snapshot, audit, routeError, metricsError, configError, auditError,
    loading, globalsLoading, saving, loadedAt, notice, noticeKind, refreshRoutes, refreshGlobals, saveRoute, deleteRoute }
}
