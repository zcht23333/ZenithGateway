<template>
  <div class="max-w-xl mx-auto space-y-10 animate-in fade-in duration-300">
    <div>
      <h2 class="text-xl font-semibold tracking-tight text-slate-100">系统设置</h2>
      <p class="text-xs text-slate-500 mt-1">调整网关的全局限流策略与核心运行行为。</p>
    </div>

    <form class="space-y-8" @submit.prevent="save">
      
      <div class="flex items-center justify-between border-b border-slate-900 pb-5">
        <div>
          <div class="text-xs font-medium text-slate-200">全局请求限流</div>
          <div class="text-[11px] text-slate-500 mt-0.5">开启或关闭基于令牌桶算法的限流器。</div>
        </div>
        <label class="relative inline-flex cursor-pointer items-center">
          <input v-model="form.rateLimitEnabled" type="checkbox" class="peer sr-only" />
          <div class="h-5 w-9 rounded-full bg-slate-800 transition-colors after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:bg-slate-400 after:transition-all after:content-[''] peer-checked:bg-indigo-600 peer-checked:after:bg-white peer-checked:after:translate-x-full"></div>
        </label>
      </div>

      <div class="space-y-5">
        <div class="grid grid-cols-2 gap-4">
          <div class="space-y-1.5">
            <label class="text-[11px] font-medium uppercase tracking-wider text-slate-500">令牌补充速率 (req/s)</label>
            <input v-model.number="form.replenishRate" type="number" min="1" class="w-full rounded-md border border-slate-900 bg-[#0a0e17] px-3 py-2 text-xs font-mono text-slate-100 outline-none transition-all focus:border-indigo-500/80 focus:ring-1 focus:ring-indigo-500/20" />
          </div>
          <div class="space-y-1.5">
            <label class="text-[11px] font-medium uppercase tracking-wider text-slate-500">最大突发容量 (Burst)</label>
            <input v-model.number="form.burstCapacity" type="number" min="1" class="w-full rounded-md border border-slate-900 bg-[#0a0e17] px-3 py-2 text-xs font-mono text-slate-100 outline-none transition-all focus:border-indigo-500/80 focus:ring-1 focus:ring-indigo-500/20" />
          </div>
        </div>

        <div class="space-y-1.5">
          <label class="text-[11px] font-medium uppercase tracking-wider text-slate-500">单次请求消耗令牌数</label>
          <input v-model.number="form.requestedTokens" type="number" min="1" class="w-full rounded-md border border-slate-900 bg-[#0a0e17] px-3 py-2 text-xs font-mono text-slate-100 outline-none transition-all focus:border-indigo-500/80 focus:ring-1 focus:ring-indigo-500/20" />
        </div>
      </div>

      <div class="flex items-center justify-end pt-2">
        <button type="submit" class="rounded-md bg-slate-100 px-4 py-2 text-xs font-semibold text-slate-950 transition-all hover:bg-slate-200 active:scale-[0.98] shadow-md">
          保存修改
        </button>
      </div>
    </form>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'

const form = ref({
  rateLimitEnabled: false,
  replenishRate: 10,
  burstCapacity: 20,
  requestedTokens: 1
})

const fetchSettings = async () => {
  try {
    const res = await fetch('http://localhost:8080/api/config')
    if (res.ok) form.value = await res.json()
  } catch (e) { console.error(e) }
}

const save = async () => {
  try {
    await fetch('http://localhost:8080/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form.value)
    })
    alert('配置已成功下发并生效。')
  } catch (e) { console.error(e) }
}

onMounted(fetchSettings)
</script>