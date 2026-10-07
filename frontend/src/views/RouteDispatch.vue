<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { errorMessage } from '../api'
import { type RouteRule } from '../stores/traffic'
import { useRouteConsole } from '../routes/useRouteConsole'
import { useRouteEditorStore, confirmRouteLeave } from '../routes/editor'
import RoutePublicationReview from '../components/RoutePublicationReview.vue'
import { previewScenario, type PreviewScenario } from '../routes/preview'
import { middleLabel, targetHost, uniqueRouteLabels } from '../routes/routeIllustration'
import ZenithHeader from '../components/ZenithHeader.vue'
import DispatchPath from '../components/DispatchPath.vue'
import DispatchCopy from '../components/DispatchCopy.vue'
import DispatchDirectory from '../components/DispatchDirectory.vue'
import RouteIcon from '../components/RouteIcon.vue'
import RouteEditor from '../components/RouteEditor.vue'
import '../styles/route-console.css'
import '../styles/route-dispatch.css'

const props = withDefaults(defineProps<{ preview?: boolean }>(), { preview:false })
const preview = computed(() => props.preview)
const location = useRoute(), router = useRouter()
const scenario = computed(() => preview.value ? previewScenario(location.query.scenario) : 'normal')
const data = useRouteConsole(preview, scenario)
const { rows, config, snapshot, audit, routeError, configError, metricsError, auditError,
  loading, globalsLoading, saving:previewSaving, loadedAt, notice, noticeKind, publication, diagnostics, diagnosticsError } = data
const routeEditor = useRouteEditorStore()
const saving = computed(()=>preview.value ? previewSaving.value : routeEditor.state.saving)
const compactVersion = (v:string|null|undefined)=>v ? v.slice(0,8) + '…:' + v.slice(37) : '尚未确认'
const localMatches = computed(()=>!!publication.value && diagnostics.value?.adoptedVersion===publication.value.version)
const publicationLabel = computed(()=>diagnosticsError.value ? '本实例状态暂不可用' : !diagnostics.value ? '正在检查本实例' : diagnostics.value.status==='failed'||diagnostics.value.stale ? '保留有效路由 · 同步异常' : localMatches.value ? '本实例已生效' : '存储与本实例版本不同 · 待核对')
async function refreshConfiguration() { await Promise.all([data.refreshRoutes(), data.refreshGlobals(), data.refreshDiagnostics()]) }
const search = ref(''), ruleFilter = ref('all'), page = ref(1), selectedId = ref('')
const viewportWidth = ref(1440), dockCollapsed = ref(false), dockHeight = ref(236)
const dock = ref<HTMLElement>(), heading = ref<HTMLElement>()
let dockObserver: ResizeObserver | undefined
function resizeViewport() { viewportWidth.value = window.innerWidth }
onMounted(() => {
  resizeViewport()
  window.addEventListener('resize', resizeViewport)
  dockObserver = new ResizeObserver(entries => { dockHeight.value = entries[0].borderBoxSize[0]?.blockSize ?? entries[0].contentRect.height })
  if (dock.value) dockObserver.observe(dock.value)
})
onBeforeUnmount(() => { window.removeEventListener('resize', resizeViewport); dockObserver?.disconnect() })
const mobile = computed(() => viewportWidth.value <= 700)
const pageSize = computed(() => viewportWidth.value >= 1360 ? 6 : viewportWidth.value >= 760 ? 4 : 2)
const filtered = computed(() => {
  const term = search.value.trim().toLowerCase()
  return rows.value.filter(row => (!term || [row.id,row.path,row.uri].some(value => value.toLowerCase().includes(term))) &&
    (ruleFilter.value === 'all' || ruleFilter.value === 'rewrite' && row.rewriteEnabled ||
    ruleFilter.value === 'breaker' && row.circuitBreakerEnabled ||
    ruleFilter.value === 'plain' && !row.rewriteEnabled && !row.circuitBreakerEnabled))
})
const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / pageSize.value)))
const visible = computed(() => filtered.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value))
const selected = computed(() => rows.value.find(row => row.id === selectedId.value))
const selectedIndex = computed(() => rows.value.findIndex(row => row.id === selectedId.value) + 1)
const labels = computed(() => uniqueRouteLabels(rows.value))
const routeOrder = computed(() => new Map(rows.value.map((row,index) => [row.id,index + 1])))
const directory = ref<InstanceType<typeof DispatchDirectory>>()
const directoryOpen = ref(false)
async function selectFromDirectory(id: string) {
  const index = filtered.value.findIndex(row => row.id === id)
  if (index < 0) return
  page.value = Math.floor(index / pageSize.value) + 1
  await selectRoute(id, true)
  await nextTick()
  heading.value?.focus({preventScroll:true})
}
const selectedInPage = computed(() => visible.value.some(row => row.id === selectedId.value))
const blocked = computed(() => !!routeError.value || saving.value || loading.value || loadedAt.value == null)
const refreshing = computed(() => loading.value || globalsLoading.value)
const configurationIssue = computed(() => !!routeError.value || !!configError.value)
const configurationReading = computed(() => loading.value || !routeError.value && loadedAt.value == null || !config.value && !configError.value)
const configurationLabel = computed(() => routeError.value ? loadedAt.value == null ? '读取失败 · 尚无路由配置' : '读取失败 · 使用缓存配置' :
  loading.value ? '正在读取配置' : configError.value ? '限流配置读取失败' : configurationReading.value ? '正在读取配置' : '配置已读取')
const metricsAvailable = computed(() => !!snapshot.value && snapshot.value.enabled !== false)
const metricsIssue = computed(() => !!metricsError.value || !!auditError.value)
const auditLabel = computed(() => auditError.value ? '审计状态暂不可用' : !audit.value ? '正在读取审计状态' :
  !audit.value.enabled ? '审计已关闭' : !audit.value.accepting ? '已停止接收审计' : audit.value.pending ? '等待写入 Redis' : '审计队列已排空')
const number = (value: number | null | undefined, digits = 0) => value == null ? '—' : value.toLocaleString('en-US',{minimumFractionDigits:digits,maximumFractionDigits:digits})
const readTime = computed(() => loadedAt.value == null ? '尚未读取' : new Date(loadedAt.value).toLocaleTimeString('zh-CN',{hour12:false}))
watch(rows, value => {
  if (!value.some(row => row.id === selectedId.value)) selectedId.value =
    (preview.value ? value.find(row => scenario.value === 'dense' ? row.id.startsWith('asia-pacific') : row.id === 'order-service')?.id : '') || value[0]?.id || ''
}, { immediate:true })
watch([search,ruleFilter], () => { page.value = 1 })
watch(pageSize, size => {
  const index = filtered.value.findIndex(row => row.id === selectedId.value)
  page.value = index >= 0 ? Math.floor(index / size) + 1 : 1
})
watch(pageCount, value => { page.value = Math.min(page.value,value) })
const auxPanel = ref<'status' | 'metrics' | null>(null)
async function chooseScenario(value: PreviewScenario) {
  if (!preview.value || value === scenario.value) return
  search.value = ''; ruleFilter.value = 'all'; page.value = 1; selectedId.value = ''; auxPanel.value = null
  dockCollapsed.value = false; editorOpen.value = false; notice.value = ''
  await router.replace({query:{scenario:value}})
  await nextTick()
  const index = rows.value.findIndex(row => row.id === selectedId.value)
  page.value = index >= 0 ? Math.floor(index / pageSize.value) + 1 : 1
}
async function selectRoute(id: string, reveal = false) {
  selectedId.value = id
  if (mobile.value && reveal) {
    dockCollapsed.value = true
    await nextTick()
    heading.value?.focus({ preventScroll:true })
    heading.value?.closest('.dispatch-hero')?.scrollIntoView({block:'start',behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'})
  }
}
function resetFilters() { search.value = ''; ruleFilter.value = 'all' }
async function locateSelected() {
  resetFilters()
  await nextTick()
  const index = filtered.value.findIndex(row => row.id === selectedId.value)
  if (index >= 0) page.value = Math.floor(index / pageSize.value) + 1
  await nextTick()
  document.getElementById('dispatch-route-' + selectedId.value)?.focus({preventScroll:true})
}
async function navigateRoute(event: KeyboardEvent, id: string) {
  if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return
  event.preventDefault()
  const index = filtered.value.findIndex(row => row.id === id)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? filtered.value.length - 1 : index + (event.key === 'ArrowRight' ? 1 : -1)
  const row = filtered.value[next]
  if (!row) return
  page.value = Math.floor(next / pageSize.value) + 1
  await selectRoute(row.id)
  await nextTick()
  document.getElementById('dispatch-route-' + row.id)?.focus({preventScroll:true})
}
function selectSearchResult() { if (filtered.value[0]) void selectRoute(filtered.value[0].id, true) }
const editorOpen = ref(!preview.value && routeEditor.state.open && routeEditor.state.kind==='save'), editing = ref<RouteRule | null>(!preview.value ? routeEditor.state.original : null), editError = ref('')
watch(()=>routeEditor.state.open,open=>{if(!preview.value)editorOpen.value=open&&routeEditor.state.kind==='save'})
onBeforeUnmount(()=>{if(!preview.value)routeEditor.cancelRead()})
function openEditor(row: RouteRule | null) {
  if(blocked.value)return
  if(!preview.value){if(!publication.value)return;if(routeEditor.state.open&&!confirmRouteLeave(routeEditor))return;routeEditor.begin(publication.value.snapshot,row)}
  editing.value=row?{...row}:null;editError.value='';editorOpen.value=true
}
function closeEditor(){if(preview.value){editorOpen.value=false;return}if(confirmRouteLeave(routeEditor))editorOpen.value=false}
async function saveRoute(row: RouteRule) {
  const editSession=routeEditor.state.draft
  editError.value = ''
  try {
    let saved:RouteRule
    if(preview.value)saved=await data.saveRoute(row)
    else {
      Object.assign(routeEditor.state.draft,row)
      const result=await routeEditor.submit();if(!result)return
      saved=result.routes.find(r=>r.id===routeEditor.state.draft.id)!
      await Promise.all([data.refreshRoutes(),data.refreshDiagnostics()])
      if(routeEditor.state.draft!==editSession)return
      notice.value=routeEditor.state.message+(routeError.value?' 列表刷新失败，请重试读取。':'');noticeKind.value=result.adoption==='adopted'&&!routeError.value?'success':'warning'
    }
    editorOpen.value = false; resetFilters()
    await nextTick()
    const index = rows.value.findIndex(item => item.id === saved.id)
    if (index >= 0) { selectedId.value = saved.id; page.value = Math.floor(index / pageSize.value) + 1 }
  } catch (error) { editError.value = errorMessage(error) }
}
const fieldsDialog = ref<HTMLDialogElement>(), deleteDialog = ref<HTMLDialogElement>()
const deleteTarget = ref<RouteRule | null>(null), deleteError = ref('')
const fullFields = computed(() => selected.value ? [
  {key:'id',label:'路由 ID',value:selected.value.id},
  {key:'path',label:'匹配路径 · Path',value:selected.value.path},
  {key:'uri',label:'目标地址 · URI',value:selected.value.uri},
  {key:'rewriteEnabled',label:'路径重写',value:String(selected.value.rewriteEnabled)},
  {key:'rewriteRegex',label:'重写正则 · Java',value:selected.value.rewriteRegex ?? ''},
  {key:'rewriteReplacement',label:'替换目标',value:selected.value.rewriteReplacement ?? ''},
  {key:'circuitBreakerEnabled',label:'熔断保护',value:String(selected.value.circuitBreakerEnabled)},
  {key:'circuitBreakerName',label:'熔断器名称',value:selected.value.circuitBreakerName},
  {key:'fallbackPath',label:'降级路径',value:selected.value.fallbackPath}
] : [])
async function requestDelete() {
  if (!selected.value || blocked.value) return
  if(!preview.value){
    if(!publication.value)return
    if(routeEditor.state.open&&!confirmRouteLeave(routeEditor))return
    routeEditor.begin(publication.value.snapshot,selected.value,'delete')
  }
  deleteTarget.value = {...selected.value}; deleteError.value = '' 
  fieldsDialog.value?.close()
  document.getElementById('dispatch-fields-open')?.focus()
  await nextTick()
  deleteDialog.value?.showModal()
}
async function confirmDelete() {
  const editSession=routeEditor.state.draft
  if (!deleteTarget.value) return
  try {
    if(preview.value)await data.deleteRoute(deleteTarget.value.id)
    else {const result=await routeEditor.submit();if(!result)return;await Promise.all([data.refreshRoutes(),data.refreshDiagnostics()]);if(routeEditor.state.draft!==editSession)return;notice.value=routeEditor.state.message+(routeError.value?' 列表刷新失败，请重试读取。':'');noticeKind.value=result.adoption==='adopted'&&!routeError.value?'success':'warning'}
    deleteDialog.value?.close();deleteTarget.value=null
  }
  catch (error) { deleteError.value = errorMessage(error) }
}
function closeDelete(){if(preview.value||confirmRouteLeave(routeEditor)){deleteDialog.value?.close();deleteTarget.value=null}}
onMounted(async()=>{if(!preview.value&&routeEditor.state.open&&routeEditor.state.kind==='delete'){deleteTarget.value={...routeEditor.state.draft};await nextTick();deleteDialog.value?.showModal()}})
</script>
<template>
  <div class="dispatch-view" :style="{ '--dock-height':dockHeight + 'px' }" @click="auxPanel = null" @keydown.esc="auxPanel = null">
    <ZenithHeader :preview="preview">
      <div class="dispatch-global">
        <button class="dispatch-global-summary" :class="{ 'has-issue':metricsIssue }" aria-label="查看网关全局指标" :aria-expanded="auxPanel === 'metrics'" aria-controls="dispatch-metrics-detail" @click.stop="auxPanel = auxPanel === 'metrics' ? null : 'metrics'">
          <RouteIcon name="activity" :size="17" /><span>网关全局<span v-if="metricsIssue" class="dispatch-metric-warning"> · 部分不可用</span></span><span class="dispatch-inline-metric">QPS <strong>{{ metricsAvailable ? number(snapshot?.qps,2) : '—' }}</strong></span><span class="dispatch-inline-metric">P95 <strong>{{ !metricsAvailable ? '—' : snapshot?.p95LatencyMs === -1 ? '> 60,000' : number(snapshot?.p95LatencyMs) }}</strong> ms</span><span class="dispatch-inline-metric" :class="audit?.pending ? 'is-warning' : ''">审计待写入 <strong>{{ number(audit?.pending) }}</strong></span><RouteIcon name="chevron" :size="14" />
        </button>
        <div v-if="auxPanel === 'metrics'" id="dispatch-metrics-detail" class="dispatch-aux-panel" @click.stop>
          <h3>网关全局指标 <span v-if="preview">演示值</span></h3>
          <p v-if="metricsError" class="dispatch-panel-error">流量指标暂不可用：{{ metricsError }}</p>
          <p v-else-if="!snapshot">正在读取流量指标…</p>
          <p v-else-if="snapshot.enabled === false">监控统计已关闭。</p>
          <p v-else>QPS 与 P95 基于最近 {{ snapshot.windowSeconds }} 秒窗口，窗口请求 {{ number(snapshot.requestCount) }} 次。</p>
          <p>{{ auditLabel }}<template v-if="auditError">：{{ auditError }}</template>。</p>
          <p v-if="audit">审计待写入 {{ audit.pending }} 条，包括队列 {{ audit.queueDepth }} 条及写入中 {{ audit.inFlight }} 条。</p>
          <p>这些指标属于整个网关，路由选择不会改变其统计范围。</p>
        </div>
      </div>
    </ZenithHeader>
    <div class="dispatch-context-bar" :class="{ 'has-error':configurationIssue }">
      <span v-if="preview" class="dispatch-demo"><span>CONCEPT 02</span>演示数据 · 不连接真实网关</span><span v-else class="dispatch-environment">网关控制台</span>
      <div class="dispatch-config-state">
        <button :class="{ 'is-error':configurationIssue, 'is-reading':configurationReading && !configurationIssue }" :aria-expanded="auxPanel === 'status'" aria-controls="dispatch-status-detail" @click.stop="auxPanel = auxPanel === 'status' ? null : 'status'"><RouteIcon :name="configurationIssue ? 'alert' : configurationReading ? 'refresh' : 'check'" :size="15" /><span role="status">{{ configurationLabel }}</span><RouteIcon name="chevron" :size="13" /></button>
        <button class="dispatch-status-refresh" :disabled="refreshing || saving" :aria-label="configurationIssue ? '重试读取' : '刷新配置'" :title="configurationIssue ? '重试读取' : '刷新配置'" @click="refreshConfiguration"><RouteIcon name="refresh" :size="15" /><span v-if="configurationIssue">重试</span></button>
        <div v-if="auxPanel === 'status'" id="dispatch-status-detail" class="dispatch-aux-panel" @click.stop>
          <h3>{{ configurationIssue ? '配置读取失败' : configurationReading ? '正在读取配置' : '配置读取成功' }}</h3>
          <p v-if="routeError">{{ routeError }}。{{ loadedAt == null ? '尚未取得路由配置，请重试读取。' : '保留上次读取的配置，恢复读取后可以继续修改。' }}</p>
          <p v-if="configError">全局限流配置未获取：{{ configError }}。限流节点暂不推断是否放行。</p>
          <p v-if="loadedAt != null">{{ preview ? '示例读取时间' : '路由读取时间' }}：<span class="dispatch-mono">{{ readTime }}</span>，共 {{ rows.length }} 条。</p>
          <p>读取状态说明配置是否取得；上游健康状态和实时请求追踪尚未接入。</p>
          <button v-if="configurationIssue" class="dispatch-button" :disabled="refreshing || saving" @click="refreshConfiguration">重试读取</button>
        </div>
      </div>
      <div v-if="preview" class="dispatch-scenarios" aria-label="预览场景"><button v-for="item in [{id:'normal',label:'正常'},{id:'exception',label:'异常'},{id:'dense',label:'32 条 / 长名称'}]" :key="item.id" :aria-pressed="scenario === item.id" @click="chooseScenario(item.id as PreviewScenario)">{{ item.label }}</button></div>
    </div>

    <aside v-if="!preview && publication" class="route-publication-strip" :class="{'is-pending':!localMatches||diagnostics?.stale||diagnosticsError}" aria-label="路由发布状态">
      <span>存储 <code :title="publication.version">{{ compactVersion(publication.version) }}</code></span>
      <span role="status">{{ publicationLabel }}</span>
      <span>本实例 <code :title="diagnostics?.adoptedVersion??''">{{ compactVersion(diagnostics?.adoptedVersion) }}</code></span>
      <details><summary>同步详情</summary><p>实例 {{ diagnostics?.instanceId ?? publication.instanceId }}</p><p>存储版本 {{ publication.version }} <DispatchCopy :value="publication.version" label="存储路由版本" /></p><p>实际匹配版本 {{ diagnostics?.adoptedVersion??'未知' }}</p><p>最近观察 {{ diagnostics?.lastObservedVersion??'尚未完成' }} · {{ diagnostics?.lastObservedAt??'—' }}</p><p>{{ diagnosticsError || diagnostics?.reason || '仅表示本实例的观察与采用；其他实例异步同步。' }}</p><p>目录展示已读取的存储快照，真实匹配使用本实例已采用版本。当前值不证明某次未确认提交是否成功。</p></details>
    </aside>
    <main class="dispatch-workspace" :aria-busy="loading">
      <template v-if="selected">
        <section class="dispatch-hero">
          <div :key="selected.id" class="dispatch-route-identity">
            <div class="dispatch-identity-eyebrow"><p>当前路由</p><span class="dispatch-route-number" aria-label="目录序号">目录 <span>{{ String(selectedIndex).padStart(2,'0') }}</span></span></div>
            <h1 ref="heading" tabindex="-1" :title="selected.id">{{ selected.id }}</h1>
          </div>
          <div class="dispatch-hero-actions"><button class="dispatch-button" :disabled="blocked" @click="openEditor(selected)"><RouteIcon name="edit" :size="18" />编辑路由</button><button class="dispatch-button is-primary" :disabled="blocked" @click="openEditor(null)"><RouteIcon name="plus" :size="19" />新建路由</button><button id="dispatch-fields-open" class="dispatch-fields-open" @click="fieldsDialog?.showModal()">查看与复制完整字段 <RouteIcon name="arrow" :size="16" /></button></div>
          <div class="dispatch-route-endpoints">
            <div class="dispatch-current-path"><span class="dispatch-endpoint-label">入口<small>Path</small></span><div class="dispatch-endpoint-value"><code>{{ selected.path }}</code><DispatchCopy :value="selected.path" label="当前匹配路径" /></div></div>
            <RouteIcon class="dispatch-endpoint-arrow" name="arrow" :size="20" />
            <div class="dispatch-current-target"><span class="dispatch-endpoint-label">目标<small>URI</small></span><div class="dispatch-endpoint-value"><code>{{ selected.uri }}</code><DispatchCopy :value="selected.uri" label="当前目标地址" /></div></div>
          </div>
        </section>
        <DispatchPath :route="selected" :config="config" @inspect="mobile && (dockCollapsed = true)" />
      </template>
      <div v-else-if="loading || loadedAt == null && !routeError" class="dispatch-empty-workspace" role="status"><RouteIcon name="refresh" :size="42" /><h1>正在读取路由配置</h1><p>配置取得后将在这里展开请求处理路径。</p></div>
      <div v-else-if="routeError" class="dispatch-empty-workspace" role="alert"><RouteIcon name="alert" :size="42" /><h1>暂时无法读取路由</h1><p>尚未取得可展示的路由配置。请在上方查看原因并重试读取。</p></div>
      <div v-else class="dispatch-empty-workspace"><RouteIcon name="target" :size="48" /><h1>创建第一条路由</h1><p>从匹配入口开始，连接请求与目标服务。</p><button class="dispatch-button is-primary" :disabled="blocked" @click="openEditor(null)">新建路由</button></div>
      <p class="dispatch-sr-only" role="status">当前路由：{{ selected?.id || '暂无路由' }}。{{ routeError ? loadedAt == null ? '路由配置尚未取得。' : '配置读取失败，正在查看缓存配置。' : '' }}</p>
    </main>

    <section ref="dock" class="dispatch-dock" :class="{ 'is-collapsed':mobile && dockCollapsed }" aria-labelledby="dispatch-directory-title" :aria-busy="loading">
      <div class="dispatch-dock-controls">
        <div class="dispatch-dock-heading"><h2 id="dispatch-directory-title">路由目录</h2><span class="dispatch-directory-count">{{ loadedAt == null ? '—' : rows.length }}</span><button class="dispatch-all-open" :disabled="loadedAt == null" aria-haspopup="dialog" aria-controls="dispatch-all-routes" :aria-expanded="directoryOpen" @click="directory?.open()">全部路由 <RouteIcon name="arrow" :size="13" /></button><button class="dispatch-dock-toggle" :aria-expanded="!dockCollapsed" @click="dockCollapsed = !dockCollapsed">{{ dockCollapsed ? '展开目录' : '收起目录' }}<RouteIcon name="chevron" :size="15" /></button></div>
        <div class="dispatch-dock-tools">
          <label class="dispatch-search"><RouteIcon name="search" :size="17" /><input v-model="search" type="search" placeholder="搜索 ID、Path 或 URI" aria-label="搜索路由" @keydown.enter.prevent="selectSearchResult" /></label>
          <label class="dispatch-rule-filter"><RouteIcon name="filter" :size="15" /><select v-model="ruleFilter" aria-label="筛选处理规则"><option value="all">全部处理规则</option><option value="rewrite">启用路径重写</option><option value="breaker">启用熔断保护</option><option value="plain">无重写及熔断</option></select></label>
        </div>
        <div class="dispatch-pagination">
          <span>{{ filtered.length ? (page - 1) * pageSize + 1 : 0 }}–{{ Math.min(page * pageSize,filtered.length) }} / {{ filtered.length }}</span>
          <button :disabled="page <= 1" aria-label="上一页" @click="page--"><RouteIcon name="left" :size="15" /></button>
          <select v-model.number="page" aria-label="跳转页码"><option v-for="value in pageCount" :key="value" :value="value">{{ value }} / {{ pageCount }}</option></select>
          <button :disabled="page >= pageCount" aria-label="下一页" @click="page++"><RouteIcon name="right" :size="15" /></button>
        </div>
      </div>
      <div class="dispatch-dock-routes">
        <div class="dispatch-dock-caption"><span>{{ !selected ? '路由目录' : selectedInPage ? '选择路由，切换上方处理路径' : '当前路由保留在画布中' }}</span><button v-if="!selectedInPage && selected" @click="locateSelected">定位当前路由 <RouteIcon name="target" :size="13" /></button><span v-else-if="selected" class="dispatch-keyboard-hint">← → 切换 · Enter 选择</span></div>
        <ol v-if="visible.length" class="dispatch-route-strip" :style="{ '--route-columns':pageSize }">
          <li v-for="row in visible" :key="row.id"><button :id="'dispatch-route-' + row.id" class="dispatch-route-card" :class="{ 'is-selected':selectedId === row.id }" :aria-pressed="selectedId === row.id" :aria-label="'选择路由 ' + row.id + '；' + row.path + '；' + row.uri" :title="row.id + '\n' + row.path + '\n' + row.uri" @click="selectRoute(row.id,true)" @keydown="navigateRoute($event,row.id)">
            <span class="dispatch-card-head"><span class="dispatch-card-number">{{ String(rows.findIndex(item => item.id === row.id) + 1).padStart(2,'0') }}</span><strong>{{ labels.get(row.id) }}</strong><span v-if="selectedId === row.id" class="dispatch-selected-mark" aria-hidden="true" /></span>
            <span class="dispatch-card-meta"><code>{{ middleLabel(row.path,30) }}</code><span>{{ middleLabel(targetHost(row.uri),25) }}</span></span>
          </button></li>
        </ol>
        <div v-else class="dispatch-no-results"><span>{{ rows.length ? '没有匹配的路由' : loading ? '正在读取目录…' : loadedAt == null ? '尚未取得路由配置' : '目录为空' }}</span><button v-if="rows.length" @click="resetFilters">清除筛选</button><span v-if="selected">当前配置视图保持不变</span></div>
      </div>
    </section>

    <div v-if="notice" class="dispatch-toast" :class="{ 'is-warning':noticeKind === 'warning' }" role="status"><RouteIcon :name="noticeKind === 'warning' ? 'alert' : 'check'" :size="18" /><span>{{ notice }}</span><button class="dispatch-icon-button" aria-label="关闭提示" @click="notice = ''"><RouteIcon name="close" :size="16" /></button></div>
    <DispatchDirectory ref="directory" v-model:search="search" v-model:filter="ruleFilter" :rows="filtered" :total="rows.length" :selected-id="selectedId" :order="routeOrder" :stale="!!routeError" @select="selectFromDirectory" @open-change="directoryOpen = $event" @reset="resetFilters" />
    <RouteEditor v-if="editorOpen" :route="editing" :saving="saving" :error="preview?editError:(routeEditor.state.message||editError)" :preview="preview" :draft="preview?undefined:routeEditor.state.draft" :publication="preview?undefined:routeEditor.state" :current="routeEditor.currentRoute" :can-submit="preview||routeEditor.canSubmit" @read="routeEditor.readCurrent" @review="routeEditor.confirmReview" @close="closeEditor" @save="saveRoute" />
    <dialog ref="fieldsDialog" class="dispatch-fields-dialog" aria-labelledby="dispatch-fields-title">
      <header><div><p>当前路由</p><h2 id="dispatch-fields-title">完整配置字段</h2></div><button class="dispatch-icon-button" autofocus aria-label="关闭完整字段" @click="fieldsDialog?.close()"><RouteIcon name="close" /></button></header>
      <div class="dispatch-fields-body"><div v-for="field in fullFields" :key="field.key" class="dispatch-value"><span>{{ field.label }} <small>{{ field.key }}</small></span><div><code>{{ field.value || '未设置' }}</code><DispatchCopy :value="field.value" :label="field.label" /></div></div></div>
      <footer><button class="dispatch-button is-danger" :disabled="blocked" @click="requestDelete"><RouteIcon name="trash" :size="17" />删除路由</button><span>全部 JSON <DispatchCopy :value="JSON.stringify(selected,null,2)" label="全部 JSON" /></span></footer>
    </dialog>
    <dialog ref="deleteDialog" class="orbit-dialog orbit-delete" aria-labelledby="dispatch-delete-title" @cancel.prevent="closeDelete"><h2 id="dispatch-delete-title">{{ preview ? '删除这条演示路由？' : '删除这条路由？' }}</h2><p>{{ preview ? '仅删除当前页面内存中的示例配置。' : '删除后，此规则将不再参与请求匹配。' }}</p><code>{{ deleteTarget?.id }}</code><p v-if="deleteError||(!preview&&routeEditor.state.message)" class="orbit-form-error" role="alert">{{ deleteError||routeEditor.state.message }}</p><RoutePublicationReview v-if="!preview" :state="routeEditor.state" :current="routeEditor.currentRoute" @read="routeEditor.readCurrent" @review="routeEditor.confirmReview" /><footer class="orbit-dialog-footer"><button class="orbit-button" autofocus :disabled="saving" @click="closeDelete">取消</button><button class="orbit-button orbit-danger" :disabled="saving||(!preview&&!routeEditor.canSubmit)" @click="confirmDelete">{{ saving ? '删除中…' : '确认删除' }}</button></footer></dialog>
  </div>
</template>

<style>
.route-publication-strip{position:relative;z-index:4;display:flex;align-items:center;flex-wrap:wrap;gap:10px 24px;padding:9px 3.5%;background:#182325;color:#dce7dc;font-size:14px;border-bottom:1px solid #364342}.route-publication-strip code{font-size:13px;color:#cdf574}.route-publication-strip.is-pending{border-bottom-color:#a58c41;color:#ffe6a5}.route-publication-strip details{margin-left:auto}.route-publication-strip summary{cursor:pointer}.route-publication-strip details[open]{width:100%;margin:0}.route-publication-strip p{overflow-wrap:anywhere;line-height:1.6}.orbit-delete:has(.route-publication-review){max-width:760px;width:calc(100vw - 32px);max-height:90vh;overflow:auto}
</style>
