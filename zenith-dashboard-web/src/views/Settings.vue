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

    <div class="rounded-xl border border-slate-800 bg-slate-900 p-6">
      <h2 class="mb-4 text-lg font-semibold">Dynamic Routes</h2>

      <form class="grid grid-cols-1 gap-3 md:grid-cols-2" @submit.prevent="saveRoute">
        <input v-model="routeForm.id" class="rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm" placeholder="Route ID" required />
        <input v-model="routeForm.path" class="rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm" placeholder="Path (e.g. /proxy/**)" required />
        <input v-model="routeForm.uri" class="rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm" placeholder="URI (e.g. https://httpbin.org)" required />
        <input v-model="routeForm.rewriteRegex" class="rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm" placeholder="Rewrite Regex" />
        <input v-model="routeForm.rewriteReplacement" class="rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm" placeholder="Rewrite Replacement" />
        <input v-model="routeForm.fallbackPath" class="rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm" placeholder="Fallback Path" />

        <label class="flex items-center gap-2 text-sm">
          <input v-model="routeForm.rewriteEnabled" type="checkbox" /> Rewrite
        </label>
        <label class="flex items-center gap-2 text-sm">
          <input v-model="routeForm.circuitBreakerEnabled" type="checkbox" /> Circuit Breaker
        </label>

        <input v-model="routeForm.circuitBreakerName" class="rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm md:col-span-2" placeholder="Circuit Breaker Name" />

        <button class="rounded bg-emerald-500 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-400 md:col-span-2" type="submit">
          Save Route
        </button>
      </form>

      <div class="mt-5 space-y-2">
        <div v-for="route in store.routes" :key="route.id" class="flex items-center justify-between rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm">
          <div class="truncate pr-3">
            <span class="font-medium">{{ route.id }}</span>
            <span class="mx-2 text-slate-500">{{ route.path }}</span>
            <span class="text-slate-300">{{ route.uri }}</span>
          </div>
          <button class="rounded bg-rose-500 px-2 py-1 text-xs text-white hover:bg-rose-400" @click="removeRoute(route.id)">Delete</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { reactive, onMounted } from 'vue'
import { useTrafficStore, type RuntimeConfig, type RouteRule } from '../stores/traffic'

const store = useTrafficStore()

const form = reactive<RuntimeConfig>({
  rateLimitEnabled: true,
  replenishRate: 20,
  burstCapacity: 20,
  requestedTokens: 1,
  monitorWindowSeconds: 10,
  emitIntervalSeconds: 1
})

const routeForm = reactive<RouteRule>({
  id: 'httpbin-anything',
  path: '/proxy/**',
  uri: 'https://httpbin.org',
  rewriteEnabled: true,
  rewriteRegex: '/proxy/(?<segment>.*)',
  rewriteReplacement: '/anything/${segment}',
  circuitBreakerEnabled: true,
  circuitBreakerName: 'cb-httpbin',
  fallbackPath: '/fallback/default'
})

onMounted(async () => {
  await Promise.all([store.fetchConfig(), store.fetchRoutes()])
  if (store.config) {
    Object.assign(form, store.config)
  }
})

async function save() {
  await store.saveConfig({ ...form })
}

async function saveRoute() {
  await store.saveRoute({ ...routeForm })
}

async function removeRoute(id: string) {
  await store.deleteRoute(id)
}
</script>

