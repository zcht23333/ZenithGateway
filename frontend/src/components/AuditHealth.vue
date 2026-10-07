<script setup lang="ts">
import { computed, ref } from 'vue'
import type { AuditStatus } from '../stores/traffic'
import { auditLabel, number, timeLabel, type ReadState } from '../overview/model'
import RouteIcon from './RouteIcon.vue'
const props = defineProps<{status:AuditStatus|null; state:ReadState}>()
const emit = defineEmits<{retry:[]}>()
const expanded = ref(false)
const names: Record<string,string> = {queue_full:'队列已满',byte_limit:'内存预算已满',oversized:'记录过大',serialization:'序列化失败',shutdown:'停机未写入'}
const reasons = computed(()=>Object.entries(props.status?.droppedByReason ?? {}).filter(([,n])=>n>0).map(([reason,n])=>(names[reason]??reason)+' '+number(n)).join('；'))
const cumulative = computed(()=>props.status ? [
  ['已接收',number(props.status.received),'进入审计发布器的记录'],
  ['已确认写入',number(props.status.persisted),'收到 Redis 的写入确认'],
  ['累计丢弃',number(props.status.dropped),'按原因统计，非当前故障判断'],
  ['结果未知',number(props.status.uncertain),'未获确认，可能已经写入 Redis'],
  ['累计重试',number(props.status.retries),'本次进程运行的重试次数'],
  ['确认比例',props.status.received ? number(100*props.status.persisted/props.status.received,2)+'%' : '暂无记录','已确认写入 / 已接收']
] : [])
</script>
<template>
  <section class="overview-audit" aria-labelledby="overview-audit-title">
    <div class="overview-audit-summary">
      <div class="overview-audit-name"><h2 id="overview-audit-title">审计写入</h2><p :class="{ 'is-warning':status?.enabled && !status?.accepting }">{{ state.error ? status ? '旧状态 · 读取失败' : '状态读取失败' : state.loading && !status ? '正在读取状态' : auditLabel(status) }}</p></div>
      <dl><dt>待写入</dt><dd>{{ number(status?.pending) }} <small>条</small></dd></dl>
      <dl><dt>最长等待</dt><dd>{{ status ? number(status.oldestAgeMs/1000,1) : '—' }} <small>秒</small></dd></dl>
      <p class="overview-audit-read-time">最近读取 <time :title="timeLabel(state.loadedAt,true)">{{ timeLabel(state.loadedAt) }}</time><span>每 5 秒独立更新</span></p>
      <button class="zenith-button overview-audit-toggle" :aria-expanded="expanded" aria-controls="overview-audit-detail" @click="expanded = !expanded">{{ expanded ? '收起详情' : '展开详情' }}<RouteIcon name="chevron" :size="17" /></button>
    </div>
    <div v-if="state.error" class="overview-source-error" role="status"><RouteIcon name="alert" :size="17" /><span>{{ state.error }}<template v-if="status">；保留 {{ timeLabel(state.loadedAt,true) }} 读取的旧状态。</template></span><button class="zenith-text-button" :disabled="state.loading" @click="emit('retry')">重试审计状态</button></div>
    <div v-if="expanded" id="overview-audit-detail" class="overview-audit-detail">
      <template v-if="status">
        <div class="overview-audit-capacity"><h3>当前队列与写入</h3><p>待写入 {{ number(status.pending) }} = 队列 {{ number(status.queueDepth) }} + 写入中 {{ number(status.inFlight) }}。待写入非零本身不代表故障。</p>
          <dl><div><dt>记录容量</dt><dd>{{ number(status.capacity) }} 条</dd></div><div><dt>预留内存 / 上限</dt><dd>{{ number(status.reservedBytes/1048576,2) }} / {{ number(status.maxReservedBytes/1048576,0) }} MiB</dd></div><div><dt>最近确认写入</dt><dd>{{ status.lastSuccessAgeMs == null ? '尚未确认写入' : number(status.lastSuccessAgeMs/1000,1)+' 秒前' }}</dd></div><div><dt>最近批次</dt><dd>{{ number(status.lastBatchSize) }} 条 · {{ number(status.lastBatchDurationMs) }} ms</dd></div></dl>
        </div>
        <div><h3>本次进程累计 <small>累计异常不等于此刻仍故障</small></h3><dl class="overview-audit-totals"><div v-for="item in cumulative" :key="item[0]"><dt>{{ item[0] }}</dt><dd>{{ item[1] }}</dd><p>{{ item[2] }}</p></div></dl><p v-if="reasons" class="overview-audit-reasons">累计丢弃原因：{{ reasons }}。</p></div>
      </template>
      <p v-else>{{ state.loading ? '正在读取审计状态…' : '尚未取得审计状态。' }}</p>
    </div>
  </section>
</template>
