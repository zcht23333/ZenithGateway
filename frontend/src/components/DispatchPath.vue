<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { RouteRule, RuntimeConfig } from '../stores/traffic'
import { middleLabel, targetHost, type StationKind } from '../routes/routeIllustration'
import RouteIcon from './RouteIcon.vue'
import DispatchInspector from './DispatchInspector.vue'
const props = defineProps<{ route: RouteRule; config: RuntimeConfig | null }>()
const emit = defineEmits<{ inspect: [] }>()
const active = ref<StationKind | null>(null)
const compact = ref(false)
const track = ref<HTMLElement>(), inspector = ref<HTMLElement>()
const width = ref(1000), panelHeight = ref(230)
let resize: ResizeObserver | undefined
let media: MediaQueryList | undefined
function updateCompact() { compact.value = !!media?.matches }
onMounted(() => {
  media = window.matchMedia('(max-width: 700px)')
  updateCompact(); media.addEventListener('change', updateCompact)
  resize = new ResizeObserver(entries => {
    for (const entry of entries) {
      if (entry.target === track.value) width.value = entry.contentRect.width
      if (entry.target === inspector.value) panelHeight.value = entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height
    }
  })
  if (track.value) resize.observe(track.value)
})
watch(inspector, (element, old) => { if (old) resize?.unobserve(old); if (element) resize?.observe(element) })
onBeforeUnmount(() => { resize?.disconnect(); media?.removeEventListener('change', updateCompact) })
watch(() => props.route.id, () => { active.value = null })
const stages = computed(() => {
  const value: { kind: StationKind; label: string; title: string; note: string; icon: string }[] = [
    { kind:'entry', label:'匹配入口', title:middleLabel(props.route.path, 30), note:'匹配入口 · Path', icon:'target' },
    { kind:'limit', label:'全局限流', title:'全局限流', note:!props.config ? '配置未获取' : props.config.rateLimitEnabled ? '按 IP 的令牌桶' : '已关闭 · 直接通过', icon:'sliders' }
  ]
  if (props.route.circuitBreakerEnabled) value.push({ kind:'breaker',label:'熔断保护',title:'熔断保护',note:'准入检查 · 完整响应统计',icon:'shield' })
  if (props.route.rewriteEnabled) value.push({ kind:'rewrite',label:'路径重写',title:'路径重写',note:'改写请求路径',icon:'edit' })
  value.push({ kind:'target',label:'目标服务',title:middleLabel(targetHost(props.route.uri), 30),note:'目标服务 · URI',icon:'server' })
  return value.map((item,index) => ({ ...item, x:index * 100 / (value.length - 1), y:item.kind === 'entry' ? 136 : item.kind === 'target' ? 72 : item.kind === 'rewrite' ? 74 : 96 }))
})
watch(stages, value => { if (active.value && !value.some(step => step.kind === active.value)) active.value = null })
const segments = computed(() => stages.value.slice(1).map((step,index) => {
  const previous = stages.value[index], x = step.x * 10, from = previous.x * 10, gap = x - from
  return { from:previous.kind, to:step.kind, path:'M ' + from + ' ' + previous.y +
    ' L ' + (from + gap * .55) + ' ' + previous.y + ' Q ' + (from + gap * .59) + ' ' + previous.y + ' ' + (from + gap * .64) + ' ' + (previous.y + (step.y - previous.y) * .33) +
    ' L ' + (from + gap * .77) + ' ' + (step.y - (step.y - previous.y) * .12) + ' Q ' + (from + gap * .80) + ' ' + step.y + ' ' + (from + gap * .84) + ' ' + step.y + ' L ' + x + ' ' + step.y }
}))
const mainPath = computed(() => segments.value.map(segment => segment.path).join(' '))
const focusedSegments = computed(() => segments.value.filter(segment => segment.from === active.value || segment.to === active.value))
const direction = computed(() => {
  const previous = stages.value[stages.value.length - 2]
  const x = (previous.x + (100 - previous.x) * .43) * 10
  return 'm' + (x - 8) + ' ' + (previous.y - 6) + ' 8 6-8 6'
})
const branches = computed(() => stages.value.filter(step => step.kind === 'breaker' || step.kind === 'limit' && props.config?.rateLimitEnabled).map(step => {
  const offset = step.kind === 'limit' ? -7 : 7
  return { kind:step.kind, x:step.x + offset, y:241, label:step.kind === 'limit' ? '令牌不足 → 429' : '熔断拒绝 → 503',
    note:step.kind === 'breaker' ? '连接错误 502 · 超时 504' : '',
    path:'M ' + step.x * 10 + ' ' + (step.y + 30) + ' L ' + (step.x * 10 + offset * 10) + ' ' + (step.y + 62) + ' L ' + (step.x * 10 + offset * 10) + ' 241' }
}))
const activeStage = computed(() => stages.value.find(step => step.kind === active.value))
const activeBranch = computed(() => branches.value.find(branch => branch.kind === active.value))
const activeNumber = computed(() => String(stages.value.findIndex(step => step.kind === active.value) + 1).padStart(2,'0'))
const panelWidth = computed(() => Math.min(430, Math.max(250, width.value * .64 - 40)))
const panelLeft = computed(() => {
  const anchor = (activeStage.value?.x ?? 50) * width.value / 100
  // Keep the conditional branch beside the panel, with its originating node visible.
  const left = active.value === 'limit' ? anchor - 30 : active.value === 'breaker' ? anchor - panelWidth.value + 30 : anchor - panelWidth.value / 2
  return Math.max(0, Math.min(width.value - panelWidth.value,left))
})
const panelTop = computed(() => Math.max(158, (activeStage.value?.y ?? 74) + (active.value === 'entry' || active.value === 'target' ? 96 : 80)))
const pointerLeft = computed(() => Math.max(18, Math.min(panelWidth.value - 18, (activeStage.value?.x ?? 50) * width.value / 100 - panelLeft.value)))
const mapHeight = computed(() => {
  const baseline = width.value < 940 ? 370 : 390
  return compact.value ? 0 : active.value ? Math.max(baseline, panelTop.value + panelHeight.value + 38) : baseline
})
async function select(kind: StationKind) {
  if (active.value === kind) { await close(); return }
  active.value = kind
  emit('inspect')
  await nextTick()
  if (compact.value) document.getElementById('dispatch-station-' + kind)?.closest('.dispatch-station')?.scrollIntoView({ block:'start', behavior:'instant' })
}
async function close() {
  const previous = active.value
  active.value = null
  await nextTick()
  if (previous) document.getElementById('dispatch-station-' + previous)?.focus({ preventScroll:true })
}
</script>
<template>
  <section class="dispatch-map" :class="{ 'has-inspector': active, 'is-compact': compact }" :style="compact ? {} : { minHeight:mapHeight + 'px' }" aria-labelledby="dispatch-path-title" @keydown.esc.stop="close">
    <header class="dispatch-map-heading"><div><h2 id="dispatch-path-title">请求处理路径</h2><p v-if="activeStage" class="dispatch-active-context" role="status">正在查看 {{ activeStage.label }} <span>·</span> {{ activeBranch ? '关联分支：' + activeBranch.label : '规则与路径示例' }}</p><p v-else>按当前配置展开 <span>·</span> 点击节点查看规则与示例</p></div><span class="dispatch-map-mode" :class="{ 'is-focused':active }">{{ active ? '阶段 ' + activeNumber : '配置视图' }}</span></header>
    <div ref="track" class="dispatch-track">
      <div :key="route.id" class="dispatch-track-content">
        <svg class="dispatch-rail-svg" viewBox="0 0 1000 330" preserveAspectRatio="none" aria-hidden="true">
          <path class="dispatch-main-rail" :d="mainPath" />
          <path v-for="segment in focusedSegments" :key="segment.from" class="dispatch-selected-rail" :d="segment.path" />
          <path class="dispatch-direction" :d="direction" />
          <path v-for="branch in branches" :key="branch.kind" class="dispatch-branch-rail" :class="{ 'is-related':active === branch.kind, 'is-secondary':active && active !== branch.kind }" :d="branch.path" />
        </svg>
        <ol class="dispatch-stations">
          <li v-for="(step,index) in stages" :key="step.kind" :class="['dispatch-station','station-' + step.kind,{ 'is-inspected':active === step.kind, 'is-adjacent':active && focusedSegments.some(segment => segment.to === step.kind || segment.from === step.kind) }]" :style="{ left:step.x + '%',top:step.y + 'px',width:compact ? undefined : Math.min(220,width / (stages.length - 1) * .9) + 'px' }">
            <button :id="'dispatch-station-' + step.kind" class="dispatch-station-button" :data-kind="step.kind" :aria-label="step.label + '：查看规则与示例'" :aria-expanded="active === step.kind" :aria-controls="active === step.kind ? 'dispatch-node-' + step.kind : undefined" @click="select(step.kind)">
              <span class="dispatch-station-disc"><span v-if="step.kind === 'entry'" class="dispatch-entry-dot" /><RouteIcon v-else :name="step.icon" :size="27" /><span class="dispatch-station-order">{{ String(index + 1).padStart(2,'0') }}</span></span>
              <span class="dispatch-station-label"><strong :class="{ 'is-code':step.kind === 'entry' || step.kind === 'target' }">{{ step.title }}</strong><small>{{ step.note }}</small></span>
            </button>
            <template v-if="compact">
              <button v-for="branch in branches.filter(item => item.kind === step.kind)" :key="branch.kind" class="dispatch-mobile-branch" :class="{ 'is-related':active === branch.kind }" @click="select(step.kind)"><span>{{ branch.label }}</span><code v-if="branch.note">{{ branch.note }}</code></button>
              <div v-if="active === step.kind" :id="'dispatch-node-' + step.kind" class="dispatch-node-inspector is-inline"><DispatchInspector :kind="step.kind" :route="route" :config="config" @close="close" /></div>
            </template>
          </li>
        </ol>
        <template v-if="!compact">
          <button v-for="branch in branches" :key="branch.kind" class="dispatch-branch" :class="{ 'is-related':active === branch.kind, 'is-limit':branch.kind === 'limit' }" :style="{ left:branch.x + '%',top:branch.y + 'px' }" :aria-label="branch.label + '：查看条件'" @click="select(branch.kind)"><span class="dispatch-branch-terminal" /><span>{{ branch.label }}<code v-if="branch.note">{{ branch.note }}</code></span></button>
        </template>
      </div>
      <Transition name="dispatch-inspect">
        <div v-if="active && !compact" :id="'dispatch-node-' + active" ref="inspector" class="dispatch-node-inspector" :style="{ left:panelLeft + 'px',top:panelTop + 'px',width:panelWidth + 'px','--pointer-left':pointerLeft + 'px' }">
          <DispatchInspector :kind="active" :route="route" :config="config" @close="close" />
        </div>
      </Transition>
    </div>
    <footer class="dispatch-map-footer"><span><RouteIcon name="activity" :size="17" />响应完成后 <span class="dispatch-completion-arrow">→</span> 监控统计 · 异步审计（启用时）</span><span class="dispatch-map-legend"><i />处理顺序 <i class="is-branch" />条件分支</span></footer>
  </section>
</template>
