<template>
  <section class="space-y-4">
    <div class="grid grid-cols-1 gap-3 md:grid-cols-4">
      <div class="rounded-xl border border-slate-800 bg-slate-900 p-4">
        <div class="text-xs text-slate-400">QPS</div>
        <div class="mt-2 text-2xl font-semibold">{{ latest?.qps?.toFixed(2) ?? '0.00' }}</div>
      </div>
      <div class="rounded-xl border border-slate-800 bg-slate-900 p-4">
        <div class="text-xs text-slate-400">Requests</div>
        <div class="mt-2 text-2xl font-semibold">{{ latest?.requestCount ?? 0 }}</div>
      </div>
      <div class="rounded-xl border border-slate-800 bg-slate-900 p-4">
        <div class="text-xs text-slate-400">Avg Latency</div>
        <div class="mt-2 text-2xl font-semibold">{{ latest?.avgLatencyMs?.toFixed(1) ?? '0.0' }}ms</div>
      </div>
      <div class="rounded-xl border border-slate-800 bg-slate-900 p-4">
        <div class="text-xs text-slate-400">P95 Latency</div>
        <div class="mt-2 text-2xl font-semibold">{{ latest?.p95LatencyMs ?? 0 }}ms</div>
      </div>
    </div>

    <div class="rounded-xl border border-slate-800 bg-slate-900 p-4">
      <TrafficChart :points="series" />
    </div>

    <LogStream :logs="logs" />
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import TrafficChart from '../components/TrafficChart.vue'
import LogStream from '../components/LogStream.vue'
import { useTrafficStore } from '../stores/traffic'

const store = useTrafficStore()

const latest = computed(() => store.latest)
const series = computed(() => store.series)
const logs = computed(() => store.logs)

onMounted(() => {
  store.bootstrap().catch((error) => {
    console.error('Failed to initialize dashboard', error)
  })
})
</script>

