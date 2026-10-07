<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useTrafficStore } from '../stores/traffic'
import { number, timeLabel, type OverviewData } from '../overview/model'
import { overviewFixture, overviewScenario, overviewScenarios } from '../overview/preview'
import ZenithHeader from '../components/ZenithHeader.vue'
import TrafficChart from '../components/TrafficChart.vue'
import LogStream from '../components/LogStream.vue'
import AuditHealth from '../components/AuditHealth.vue'
import RouteIcon from '../components/RouteIcon.vue'
import '../styles/overview.css'
const props = withDefaults(defineProps<{preview?:boolean}>(),{preview:false})
const route = useRoute(), router = useRouter(), store = useTrafficStore()
const scenario = computed(()=>overviewScenario(route.query.scenario))
const demo = ref(overviewFixture(scenario.value)), clock = ref(Date.now())
const data = computed<OverviewData>(()=>props.preview ? demo.value : store)
const latest = computed(()=>data.value.latest)
const now = computed(()=>props.preview ? demo.value.now : clock.value)
const available = computed(()=>!!latest.value && latest.value.enabled !== false)
const stale = computed(()=>!!latest.value && (!!data.value.snapshotState.error || !!data.value.streamError ||
  now.value - latest.value.timestamp > 15000 || data.value.snapshotState.loadedAt == null || now.value - data.value.snapshotState.loadedAt > 15000))
const freshness = computed(()=>!latest.value ? data.value.snapshotState.error ? '窗口指标读取失败' : '正在等待窗口指标' :
  stale.value ? '旧数据 · 等待更新' : latest.value.enabled === false ? '流量监控已关闭' : '窗口指标已更新')
const streamLabel = computed(()=>data.value.streamError ? '指标订阅中断 / 重试中' : data.value.connected ? '指标订阅已连接' : '正在连接指标订阅')
const sourceDetails = computed(()=>[
  {key:'snapshot' as const,label:'当前窗口',state:data.value.snapshotState},
  {key:'series' as const,label:'历史采样',state:data.value.seriesState},
  {key:'audit' as const,label:'审计状态',state:data.value.auditState},
  {key:'logs' as const,label:'最近记录',state:data.value.logsState}
])
let ticker: ReturnType<typeof setInterval> | undefined
onMounted(()=>{if(!props.preview){void store.bootstrap();ticker=setInterval(()=>{clock.value=Date.now()},1000)}})
onBeforeUnmount(()=>{clearInterval(ticker);if(!props.preview)store.disconnectSse()})
watch(scenario,value=>{if(props.preview)demo.value=overviewFixture(value)})
function setScenario(event:Event){void router.replace({query:{scenario:(event.target as HTMLSelectElement).value}})}
async function retry(source:'snapshot'|'series'|'logs'|'audit'|'stream') {
  if (!props.preview) { await store.retry(source); return }
  const restored = overviewFixture('normal')
  if(source === 'stream' || source === 'snapshot') {
    demo.value.latest=restored.latest; demo.value.snapshotState=restored.snapshotState
    demo.value.connected=true; demo.value.streamError=''; demo.value.streamConnecting=false; demo.value.now=restored.now
  } else if(source === 'series') {demo.value.series=restored.series;demo.value.seriesState=restored.seriesState}
  else if(source === 'logs') {demo.value.logs=restored.logs;demo.value.logsState=restored.logsState}
  else {demo.value.auditStatus=restored.auditStatus;demo.value.auditState=restored.auditState}
}
</script>
<template>
  <div class="overview-view">
    <ZenithHeader :preview="preview" />
    <div v-if="preview" class="overview-demo-bar"><span>演示数据 · 不连接真实网关</span><label>场景 <select :value="scenario" aria-label="概览演示场景" @change="setScenario"><option v-for="item in overviewScenarios" :key="item.id" :value="item.id">{{ item.label }}</option></select></label></div>
    <main>
      <div class="overview-dark-workspace">
        <header class="overview-heading">
          <div><h1>运行概览</h1><p>沿时间观察流量，辨认延迟变化。</p></div>
          <div class="overview-freshness" :class="{ 'is-stale':stale, 'has-error':!latest && data.snapshotState.error }"><span role="status"><i />{{ freshness }}</span><time :title="timeLabel(latest?.timestamp,true)">快照时间 {{ timeLabel(latest?.timestamp) }}</time></div>
          <details class="overview-source-details"><summary>数据来源 <RouteIcon name="chevron" :size="16" /></summary><div class="overview-source-popover"><h2>数据读取与更新</h2><div v-for="source in sourceDetails" :key="source.key"><strong>{{ source.label }}</strong><p>{{ source.state.loading ? '正在读取' : source.state.error ? source.state.loadedAt ? '读取失败 · 保留旧数据' : '读取失败' : source.state.loadedAt ? '已读取' : '尚未读取' }} · {{ timeLabel(source.state.loadedAt,true) }}</p><p v-if="source.state.error" class="is-error">{{ source.state.error }}</p><button class="zenith-text-button" :disabled="source.state.loading" @click="retry(source.key)">重试{{ source.label }}</button></div><div><strong>{{ streamLabel }}</strong><p>{{ data.streamError || '连接状态只说明指标更新通道，不代表上游健康。' }}</p><button class="zenith-text-button" :disabled="data.streamConnecting" @click="retry('stream')">重新连接指标订阅</button></div></div></details>
        </header>
        <div class="overview-window-context">
          <p>当前窗口 <strong>{{ latest ? latest.windowSeconds : '—' }}</strong> 秒 <span>· 已结束代理请求 <strong>{{ available ? number(latest?.requestCount) : '—' }}</strong> 次</span></p>
          <details class="overview-window-details"><summary>平均延迟 {{ available ? number(latest?.avgLatencyMs,1) : '—' }} ms <RouteIcon name="chevron" :size="15" /></summary><div><p>同一窗口内：取消 {{ available ? number(latest?.cancelled) : '—' }} 次、请求异常 {{ available ? number(latest?.errors) : '—' }} 次、未形成 HTTP 状态 {{ available ? number(latest?.unknownStatus) : '—' }} 次。</p><p>这些分类可能重叠，不相加作为请求总量。QPS = 窗口已结束请求数 ÷ 窗口秒数。</p></div></details>
        </div>
        <div v-if="data.snapshotState.error || data.streamError" class="overview-source-error" role="status"><RouteIcon name="alert" :size="17" /><span>{{ data.snapshotState.error || data.streamError }}<template v-if="latest">；保留 {{ timeLabel(latest.timestamp,true) }} 的快照。</template></span><button class="zenith-text-button" @click="retry(data.streamError ? 'stream' : 'snapshot')">重试流量更新</button></div>
        <div v-if="data.seriesState.error" class="overview-source-error" role="status"><span>历史采样：{{ data.seriesState.error }}。当前收到的采样仍可查看。</span><button class="zenith-text-button" :disabled="data.seriesState.loading" @click="retry('series')">重试历史采样</button></div>
        <TrafficChart :points="data.series" :latest="latest" :gaps="data.streamGaps" :loading="data.seriesState.loading" :error="data.seriesState.error" />
        <AuditHealth :status="data.auditStatus" :state="data.auditState" @retry="retry('audit')" />
      </div>
      <LogStream :logs="data.logs" :state="data.logsState" @retry="retry('logs')" />
    </main>
  </div>
</template>
