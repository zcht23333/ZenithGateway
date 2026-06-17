<template>
  <div class="rounded-xl border border-slate-900 bg-[#0b0f19]/30 p-4 font-mono text-[11px] h-[320px] flex flex-col">
    <div class="flex-1 overflow-y-auto space-y-2.5 pr-1">
      <div 
        v-for="item in logs" 
        :key="`${item.timestamp}-${item.path}`" 
        class="group flex flex-col gap-1 border-b border-slate-900/40 pb-2 last:border-none"
      >
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span class="font-bold tracking-wide" :class="methodClass(item.method)">{{ item.method }}</span>
            <span class="text-slate-300 truncate max-w-[140px]">{{ item.path }}</span>
          </div>
          <span class="font-semibold" :class="statusClass(item.statusCode)">{{ item.statusCode }}</span>
        </div>
        <div class="flex justify-between text-slate-600 text-[10px]">
          <span>{{ item.clientIp }}</span>
          <span>{{ item.durationMs }}ms · {{ formatTime(item.timestamp) }}</span>
        </div>
      </div>
      
      <div v-if="logs.length === 0" class="h-full flex items-center justify-center text-slate-600 italic">
        等待请求流量流入...
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { TrafficData } from '../stores/traffic'

defineProps<{ logs: TrafficData[] }>()

const formatTime = (ts: number) => {
  const d = new Date(ts)
  return `${d.toLocaleTimeString()}.${d.getMilliseconds().toString().padStart(3, '0')}`
}

const methodClass = (m: string) => {
  if (m === 'GET') return 'text-indigo-400'
  if (m === 'POST') return 'text-emerald-400'
  return 'text-amber-400'
}

const statusClass = (code: number) => {
  if (code >= 500) return 'text-rose-500'
  if (code >= 400) return 'text-amber-500'
  return 'text-slate-400'
}
</script>