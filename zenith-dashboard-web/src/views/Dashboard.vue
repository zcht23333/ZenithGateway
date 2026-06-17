<template>
  <div class="space-y-12">
    <div>
      <h2 class="text-xl font-semibold tracking-tight text-slate-100">运行总览</h2>
      <p class="text-xs text-slate-500 mt-1">网关实时流量与核心指标遥测数据。</p>
    </div>

    <div class="grid grid-cols-2 gap-x-8 gap-y-6 sm:grid-cols-4 border-y border-slate-900 py-6">
      <div class="space-y-1">
        <span class="text-[11px] font-medium uppercase tracking-wider text-slate-500">实时 QPS</span>
        <div class="text-3xl font-light tracking-tight text-slate-100 font-mono">
          {{ latest?.qps?.toFixed(2) ?? '0.00' }}
        </div>
      </div>
      <div class="space-y-1">
        <span class="text-[11px] font-medium uppercase tracking-wider text-slate-500">请求总数</span>
        <div class="text-3xl font-light tracking-tight text-slate-100 font-mono">
          {{ latest?.requestCount ?? 0 }}
        </div>
      </div>
      <div class="space-y-1">
        <span class="text-[11px] font-medium uppercase tracking-wider text-slate-500">平均延迟</span>
        <div class="text-3xl font-light tracking-tight text-slate-100 font-mono">
          {{ latest?.avgLatencyMs?.toFixed(0) ?? '0' }}<span class="text-xs text-slate-600 ml-0.5">ms</span>
        </div>
      </div>
      <div class="space-y-1">
        <span class="text-[11px] font-medium uppercase tracking-wider text-slate-500">P95 延迟</span>
        <div class="text-3xl font-light tracking-tight text-slate-100 font-mono">
          {{ latest?.p95LatencyMs ?? 0 }}<span class="text-xs text-slate-600 ml-0.5">ms</span>
        </div>
      </div>
    </div>

    <div class="grid grid-cols-1 gap-10 lg:grid-cols-3">
      <div class="lg:col-span-2 space-y-3">
        <span class="text-[11px] font-medium uppercase tracking-wider text-slate-400">流量历史趋势</span>
        <div class="rounded-xl border border-slate-900 bg-[#0b0f19]/40 p-4">
          <TrafficChart :points="store.series" />
        </div>
      </div>
      <div class="space-y-3">
        <span class="text-[11px] font-medium uppercase tracking-wider text-slate-400">实时请求流</span>
        <LogStream :logs="store.logs" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, computed } from 'vue'
import { useTrafficStore } from '../stores/traffic'
import TrafficChart from '../components/TrafficChart.vue'
import LogStream from '../components/LogStream.vue'

const store = useTrafficStore()
const latest = computed(() => store.series[store.series.length - 1])

onMounted(() => store.bootstrap())
onBeforeUnmount(() => store.disconnectSse())
</script>