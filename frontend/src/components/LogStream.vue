<script setup lang="ts">
import { ref } from 'vue'
import type { TrafficData } from '../stores/traffic'
import { number, recordResult, timeLabel, type ReadState } from '../overview/model'
import DispatchCopy from './DispatchCopy.vue'
import RouteIcon from './RouteIcon.vue'
defineProps<{logs:TrafficData[]; state:ReadState}>()
const emit = defineEmits<{retry:[]}>()
const dialog = ref<HTMLDialogElement>(), selected = ref<TrafficData|null>(null)
function inspect(record: TrafficData) { selected.value = {...record}; dialog.value?.showModal() }
function tone(record: TrafficData) { return record.statusCode >= 500 || record.outcome === 'error' ? 'is-error' : record.statusCode >= 400 || record.outcome === 'cancelled' || !record.statusCode ? 'is-warning' : '' }
const outcome = (value?:string)=>({completed:'请求已结束',cancelled:'请求已取消',error:'请求异常'}[value??''] ?? value ?? '未提供')
</script>
<template>
  <section class="overview-records" aria-labelledby="overview-records-title">
    <header><div><h2 id="overview-records-title">最近审计记录 <span>{{ state.loadedAt == null ? '—' : logs.length }} 条</span></h2><p>Redis 中最近至多 40 条 · 每 5 秒读取 · 与当前统计窗口独立</p></div><div class="overview-records-read"><span :class="{ 'has-error':state.error }">{{ state.error ? state.loadedAt ? '旧记录 · 读取失败' : '读取失败' : state.loading ? '正在读取' : '已读取' }}</span><time :title="timeLabel(state.loadedAt,true)">最近读取 {{ timeLabel(state.loadedAt) }}</time><button class="overview-paper-button" :disabled="state.loading" @click="emit('retry')"><RouteIcon name="refresh" :size="16" />{{ state.error ? '重试读取记录' : '刷新记录' }}</button></div></header>
    <p v-if="state.error" class="overview-record-error" role="status">{{ state.error }}<template v-if="state.loadedAt">。正在显示 {{ timeLabel(state.loadedAt,true) }} 读取的记录。</template></p>
    <table v-if="logs.length" class="overview-record-table">
      <colgroup><col style="width:86px"/><col/><col style="width:204px"/><col style="width:112px"/><col style="width:198px"/></colgroup>
      <thead><tr><th scope="col">方法</th><th scope="col">请求路径 · 点击查看完整记录</th><th scope="col">结果</th><th scope="col">耗时</th><th scope="col">事件时间 · 本地</th></tr></thead>
      <tbody><tr v-for="(item,index) in logs" :key="item.eventId ?? item.timestamp+'-'+index">
        <td class="overview-record-method">{{ item.method }}</td>
        <td class="overview-record-path"><button :aria-label="'查看审计记录 '+item.path" :title="item.path" @click="inspect(item)"><code>{{ item.path }}</code><RouteIcon name="arrow" :size="16" /></button></td>
        <td class="overview-record-result" :class="tone(item)">{{ recordResult(item) }}</td>
        <td class="overview-record-duration">{{ number(item.durationMs) }} <small>ms</small></td>
        <td class="overview-record-time"><time :datetime="new Date(item.timestamp).toISOString()">{{ timeLabel(item.timestamp,true) }}</time></td>
      </tr></tbody>
    </table>
    <div v-else class="overview-record-empty" role="status"><RouteIcon :name="state.error ? 'alert' : 'activity'" :size="26" /><h3>{{ state.loading ? '正在读取审计记录' : state.error ? '尚未取得审计记录' : '暂无审计记录' }}</h3><p>{{ state.loading ? '记录取得后将在这里显示。' : '记录与流量指标分别读取，当前列表不代表实时请求流。' }}</p></div>
    <footer>事件时间可能早于当前窗口或当前进程启动时间；记录不包含 routeId。</footer>
  </section>
  <dialog ref="dialog" class="overview-record-dialog" aria-labelledby="overview-record-detail-title">
    <header><div><p>最近审计记录</p><h2 id="overview-record-detail-title">完整记录</h2></div><button class="zenith-icon-button" autofocus aria-label="关闭完整记录" @click="dialog?.close()"><RouteIcon name="close" /></button></header>
    <div v-if="selected" class="overview-record-detail-body">
      <div class="overview-record-full-path"><span>请求路径</span><code>{{ selected.path }}</code><DispatchCopy :value="selected.path" label="完整请求路径" /></div>
      <dl><div><dt>方法</dt><dd>{{ selected.method }}</dd></div><div><dt>HTTP 结果</dt><dd :class="tone(selected)">{{ recordResult(selected) }}</dd></div><div><dt>请求结束方式</dt><dd>{{ outcome(selected.outcome) }}</dd></div><div><dt>耗时</dt><dd>{{ number(selected.durationMs) }} ms</dd></div><div><dt>事件时间 · 本地</dt><dd>{{ timeLabel(selected.timestamp,true) }}</dd></div><div><dt>客户端 IP</dt><dd>{{ selected.clientIp }}</dd></div><div><dt>事件 ID</dt><dd>{{ selected.eventId || '未提供' }}</dd></div></dl>
    </div>
    <footer><span>完整 JSON</span><DispatchCopy v-if="selected" :value="JSON.stringify(selected,null,2)" label="审计记录 JSON" /></footer>
  </dialog>
</template>
