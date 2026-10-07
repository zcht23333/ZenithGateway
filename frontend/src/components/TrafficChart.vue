<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ECharts } from 'echarts/core'
import type { TrafficMetricsSnapshot } from '../stores/traffic'
import { buildTrend, latencyLabel, number, timeLabel } from '../overview/model'
const props = defineProps<{points:TrafficMetricsSnapshot[]; latest:TrafficMetricsSnapshot|null; gaps:number[]; loading:boolean; error:string}>()
const chartEl = ref<HTMLDivElement>(), compact = ref(false)
const engineLoading = ref(true), engineFailed = ref(false)
let active = true, engine: typeof import('../overview/chart') | undefined
const pinned = ref<number|null>(null), hovered = ref<number|null>(null)
const trend = computed(() => buildTrend(props.points,props.gaps))
const selectedIndex = computed(() => {
  const timestamp = hovered.value ?? pinned.value
  const index = trend.value.samples.findIndex(point => point.timestamp === timestamp)
  return index < 0 ? trend.value.samples.length - 1 : index
})
const selected = computed(() => trend.value.samples[selectedIndex.value] ?? null)
const range = computed(() => {
  const values = trend.value.samples
  return values.length ? timeLabel(values[0].timestamp,true) + ' — ' + timeLabel(values[values.length - 1].timestamp,true) : '尚无采样范围'
})
const available = computed(() => !!props.latest && props.latest.enabled !== false)
let chart: ECharts | undefined, resize: ResizeObserver | undefined
function render() {
  if (!chart || !chartEl.value || !engine) return
  compact.value = window.matchMedia('(max-width: 700px)').matches
  chart.setOption(engine.createOptions(trend.value,compact.value),{notMerge:true})
}
function inspect(event: Event) {
  const point = trend.value.samples[Number((event.target as HTMLInputElement).value)]
  if (!point) return
  pinned.value = point.timestamp; hovered.value = null
  chart?.dispatchAction({type:'showTip',seriesIndex:0,dataIndex:trend.value.qps.findIndex(item=>item[0]===point.timestamp)})
}
function follow() { pinned.value = null; hovered.value = null; chart?.dispatchAction({type:'hideTip'}) }
async function loadEngine() {
  engineLoading.value = true; engineFailed.value = false
  try { engine = await import('../overview/chart') }
  catch { if (active) { engineFailed.value = true; engineLoading.value = false }; return }
  if (!active || !chartEl.value) return
  engineLoading.value = false
  chart = engine.init(chartEl.value)
  chart.on('updateAxisPointer',(event:unknown)=>{
    const timestamp = (event as {axesInfo?:{value:number}[]}).axesInfo?.[0]?.value
    if (timestamp == null || !trend.value.samples.length) return
    const point = trend.value.samples.reduce((a,b)=>Math.abs(a.timestamp-timestamp)<Math.abs(b.timestamp-timestamp)?a:b)
    hovered.value = point.timestamp
  })
  chart.getZr().on('globalout',()=>{hovered.value = null})
  resize = new ResizeObserver(()=>{chart?.resize();render()})
  resize.observe(chartEl.value); render()
}
function reloadPage() { window.location.reload() }
onMounted(loadEngine)
watch(()=>[props.points,props.latest,props.gaps],async()=>{
  if (pinned.value != null && !trend.value.samples.some(point=>point.timestamp===pinned.value)) pinned.value = null
  await nextTick();render()
},{deep:true})
onBeforeUnmount(()=>{active=false;resize?.disconnect();chart?.dispose();chart=undefined})
</script>
<template>
  <section class="overview-trends" aria-labelledby="overview-trend-title">
    <header class="overview-trend-heading"><h2 id="overview-trend-title">流量与延迟</h2><p>{{ range }} <span>· {{ trend.samples.length }} / 120 个采样点</span></p></header>
    <div class="overview-trend-canvas" :class="{'has-overflow':trend.overflow.length}">
      <div ref="chartEl" class="overview-chart" role="img" :aria-label="'按实际时间排列的 QPS 和 P95 趋势，' + trend.samples.length + ' 个采样点；可用下方滑块逐点查看'" />
      <div v-if="trend.overflow.length" class="overview-overflow-lane" aria-label="P95 超范围独立事件带"><span>▲ &gt; 60,000 ms <small>独立事件标记 · {{ trend.overflow.length }} 点</small></span></div>
      <p v-if="trend.overflow.length && !trend.p95.some(point=>point[1] != null)" class="overview-p95-unbounded">暂无范围内 P95 读数</p>
      <div v-if="engineLoading || engineFailed" class="overview-engine-state" role="status"><span>{{ engineFailed ? '趋势图资源加载失败；数值与记录仍可查看。' : '正在载入趋势图…' }}</span><button v-if="engineFailed" class="zenith-text-button" @click="reloadPage">重新载入页面</button></div>
      <div class="overview-current-metric is-qps"><span>窗口平均 QPS <small>req/s</small></span><strong data-testid="qps">{{ available ? number(latest?.qps,2) : '—' }}</strong><p>每秒已结束的代理请求</p></div>
      <div class="overview-current-metric is-latency"><span>P95 延迟 <small>ms</small></span><strong data-testid="p95" :class="{ 'is-overflow':latest?.p95LatencyMs === -1 && available }">{{ latencyLabel(latest) }}</strong><p>{{ latest?.p95LatencyMs === -1 && available ? '超过 60,000 ms 上限' : '95% 请求的延迟上界' }}</p></div>
      <div v-if="!trend.samples.length" class="overview-chart-empty" role="status"><strong>{{ loading ? '正在读取采样' : error ? '采样暂不可用' : '尚无历史采样' }}</strong><span>{{ loading ? '读取完成后显示真实时间范围' : error ? '可重试读取；当前窗口独立更新' : '新快照到达后会出现在这里' }}</span></div>
      <div v-else-if="trend.samples.every(point=>point.enabled === false)" class="overview-chart-empty"><strong>流量监控已关闭</strong><span>关闭期间不绘制流量或延迟曲线</span></div>
    </div>
    <div class="overview-trend-readout">
      <span class="overview-sample-time">{{ pinned || hovered ? '查看采样' : '最新采样' }} <time>{{ timeLabel(selected?.timestamp) }}</time></span>
      <span v-if="selected?.enabled === false">该采样：监控关闭</span><span v-else>QPS <b>{{ selected ? number(selected.qps,2) : '—' }}</b> req/s <i />P95 <b>{{ latencyLabel(selected) }}</b> ms</span>
      <label class="overview-sample-slider"><span>按采样点浏览</span><input type="range" min="0" :max="Math.max(0,trend.samples.length-1)" :value="Math.max(0,selectedIndex)" :disabled="!trend.samples.length" aria-label="查看趋势采样" :aria-valuetext="selected ? timeLabel(selected.timestamp,true) + '，QPS ' + number(selected.qps,2) + '，P95 ' + latencyLabel(selected) + '毫秒' : '暂无采样'" @input="inspect" /></label>
      <button class="zenith-text-button" :disabled="pinned == null" @click="follow">跟随最新</button>
    </div>
    <p class="overview-trend-footnote">按实际采样时间排列，最多保留 120 点；关闭、订阅中断或间隔超过 6 秒处留空。<span v-if="trend.overflow.length" class="is-warning"> ▲ 超范围采样置于独立事件带，不参与延迟纵轴；对应曲线留空，仅能确定 P95 &gt; 60,000 ms。</span></p>
  </section>
</template>
