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

      <div class="flex items-center justify-between border-b border-slate-900 pb-5 pt-2">
        <div>
          <div class="text-xs font-medium text-slate-200">监控参数</div>
          <div class="text-[11px] text-slate-500 mt-0.5">调整流量指标的聚合窗口与发射频率。</div>
        </div>
      </div>

      <div class="space-y-5">
        <div class="grid grid-cols-2 gap-4">
          <div class="space-y-1.5">
            <label class="text-[11px] font-medium uppercase tracking-wider text-slate-500">聚合窗口 (秒)</label>
            <input v-model.number="form.monitorWindowSeconds" type="number" min="1" max="120" class="w-full rounded-md border border-slate-900 bg-[#0a0e17] px-3 py-2 text-xs font-mono text-slate-100 outline-none transition-all focus:border-indigo-500/80 focus:ring-1 focus:ring-indigo-500/20" />
          </div>
          <div class="space-y-1.5">
            <label class="text-[11px] font-medium uppercase tracking-wider text-slate-500">快照发射间隔 (秒)</label>
            <input v-model.number="form.emitIntervalSeconds" type="number" min="1" max="5" class="w-full rounded-md border border-slate-900 bg-[#0a0e17] px-3 py-2 text-xs font-mono text-slate-100 outline-none transition-all focus:border-indigo-500/80 focus:ring-1 focus:ring-indigo-500/20" />
          </div>
        </div>
      </div>

      <div class="flex items-center justify-between pt-2">
        <span v-if="feedback" class="text-[11px]" :class="feedback.startsWith('✅') ? 'text-emerald-400' : 'text-rose-400'">{{ feedback }}</span>
        <span v-else></span>
        <button type="submit" :disabled="saving" class="rounded-md bg-slate-100 px-4 py-2 text-xs font-semibold text-slate-950 transition-all hover:bg-slate-200 active:scale-[0.98] shadow-md disabled:opacity-50 disabled:cursor-not-allowed">
          {{ saving ? '保存中...' : '保存修改' }}
        </button>
      </div>
    </form>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useTrafficStore } from '../stores/traffic'

const store = useTrafficStore()

const form = ref({
  rateLimitEnabled: false,
  replenishRate: 10,
  burstCapacity: 20,
  requestedTokens: 1,
  monitorWindowSeconds: 10,
  emitIntervalSeconds: 1
})

const saving = ref(false)
const feedback = ref('')

const loadConfig = async () => {
  try {
    await store.fetchConfig()
    if (store.config) {
      form.value = { ...store.config }
    }
  } catch (e) {
    console.error(e)
    feedback.value = '❌ 加载配置失败'
  }
}

const save = async () => {
  saving.value = true
  feedback.value = ''
  try {
    await store.saveConfig({ ...form.value })
    // 回读服务端实际生效的值（经过 clamp 处理后的真实值）
    await store.fetchConfig()
    if (store.config) {
      form.value = { ...store.config }
    }
    feedback.value = '✅ 配置已保存并生效'
  } catch (e) {
    console.error(e)
    feedback.value = '❌ 保存失败'
  } finally {
    saving.value = false
  }
}

onMounted(loadConfig)
</script>