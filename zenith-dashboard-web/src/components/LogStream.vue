<template>
  <div class="rounded-xl border border-slate-800 bg-slate-900 p-4">
    <h3 class="mb-3 text-sm font-semibold text-slate-200">Recent Traffic Logs</h3>
    <div class="max-h-72 overflow-y-auto text-xs text-slate-300">
      <div v-for="item in logs" :key="`${item.timestamp}-${item.path}`" class="mb-2 border-b border-slate-800 pb-2">
        <div class="flex justify-between">
          <span>{{ item.method }} {{ item.path }}</span>
          <span :class="statusClass(item.statusCode)">{{ item.statusCode }}</span>
        </div>
        <div class="mt-1 text-slate-500">{{ item.clientIp }} · {{ item.durationMs }}ms · {{ format(item.timestamp) }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { TrafficData } from '../stores/traffic'

defineProps<{
  logs: TrafficData[]
}>()

function format(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString()
}

function statusClass(statusCode: number): string {
  if (statusCode >= 500) {
    return 'text-red-400'
  }
  if (statusCode >= 400) {
    return 'text-amber-300'
  }
  return 'text-emerald-300'
}
</script>

