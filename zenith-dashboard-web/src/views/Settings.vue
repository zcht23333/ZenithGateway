<template>
  <section class="space-y-6">
    <div class="max-w-xl rounded-xl border border-slate-800 bg-slate-900 p-6">
    <h2 class="mb-4 text-lg font-semibold">Gateway Runtime Settings</h2>

    <form class="space-y-4" @submit.prevent="save">
      <label class="flex items-center gap-2 text-sm">
        <input v-model="form.rateLimitEnabled" type="checkbox" />
        Enable Rate Limit
      </label>

      <label class="block text-sm">
        <span class="mb-1 block text-slate-300">Token Replenish Rate (req/s)</span>
        <input v-model.number="form.replenishRate" class="w-full rounded border border-slate-700 bg-slate-950 px-3 py-2" type="number" min="1" />
      </label>

      <label class="block text-sm">
        <span class="mb-1 block text-slate-300">Burst Capacity</span>
        <input v-model.number="form.burstCapacity" class="w-full rounded border border-slate-700 bg-slate-950 px-3 py-2" type="number" min="1" />
      </label>

      <label class="block text-sm">
        <span class="mb-1 block text-slate-300">Requested Tokens / Request</span>
        <input v-model.number="form.requestedTokens" class="w-full rounded border border-slate-700 bg-slate-950 px-3 py-2" type="number" min="1" />
      </label>

      <label class="block text-sm">
        <span class="mb-1 block text-slate-300">Monitor Window Seconds</span>
        <input v-model.number="form.monitorWindowSeconds" class="w-full rounded border border-slate-700 bg-slate-950 px-3 py-2" type="number" min="1" />
      </label>

      <label class="block text-sm">
        <span class="mb-1 block text-slate-300">SSE Emit Interval Seconds</span>
        <input v-model.number="form.emitIntervalSeconds" class="w-full rounded border border-slate-700 bg-slate-950 px-3 py-2" type="number" min="1" />
      </label>

      <button class="rounded bg-indigo-500 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-400" type="submit">Save</button>
    </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { reactive, onMounted } from 'vue'
import { useTrafficStore, type RuntimeConfig } from '../stores/traffic'

const store = useTrafficStore()

const form = reactive<RuntimeConfig>({
  rateLimitEnabled: true,
  replenishRate: 20,
  burstCapacity: 20,
  requestedTokens: 1,
  monitorWindowSeconds: 10,
  emitIntervalSeconds: 1
})

onMounted(async () => {
  await store.fetchConfig()
  if (store.config) {
    Object.assign(form, store.config)
  }
})

async function save() {
  await store.saveConfig({ ...form })
}
</script>

