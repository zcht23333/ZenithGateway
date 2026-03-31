<template>
  <section class="space-y-6">
    <div class="rounded-xl border border-slate-800 bg-slate-900 p-6">
      <h2 class="mb-4 text-lg font-semibold">Route Management</h2>
      <form class="grid grid-cols-1 gap-3 md:grid-cols-2" @submit.prevent="saveRoute">
        <input v-model="routeForm.id" class="rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm" placeholder="Route ID (optional)" />
        <input v-model="routeForm.path" class="rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm" placeholder="Path (e.g. /proxy/**)" required />
        <input v-model="routeForm.uri" class="rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm" placeholder="URI (e.g. https://httpbin.org)" required />
        <input v-model="routeForm.rewriteRegex" class="rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm" placeholder="Rewrite Regex (optional)" />
        <input v-model="routeForm.rewriteReplacement" class="rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm" placeholder="Rewrite Replacement (optional)" />
        <input v-model="routeForm.fallbackPath" class="rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm" placeholder="Fallback Path (optional)" />

        <label class="flex items-center gap-2 text-sm">
          <input v-model="routeForm.rewriteEnabled" type="checkbox" /> Rewrite
        </label>
        <label class="flex items-center gap-2 text-sm">
          <input v-model="routeForm.circuitBreakerEnabled" type="checkbox" /> Circuit Breaker
        </label>

        <input v-model="routeForm.circuitBreakerName" class="rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm md:col-span-2" placeholder="Circuit Breaker Name (optional)" />

        <button class="rounded bg-emerald-500 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-400 md:col-span-2" type="submit">
          Save Route
        </button>
      </form>
    </div>

    <div class="rounded-xl border border-slate-800 bg-slate-900 p-6">
      <h3 class="mb-4 text-base font-semibold">Active Routes</h3>
      <div v-if="store.routes.length === 0" class="text-sm text-slate-400">
        No route configured. Add one above to start proxying traffic.
      </div>
      <div class="space-y-2">
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
import { onMounted, reactive } from 'vue'
import { useTrafficStore, type RouteRule } from '../stores/traffic'

const store = useTrafficStore()

const routeForm = reactive<RouteRule>({
  id: '',
  path: '/proxy/**',
  uri: 'https://httpbin.org',
  rewriteEnabled: true,
  rewriteRegex: '/proxy/(?<segment>.*)',
  rewriteReplacement: '/anything/${segment}',
  circuitBreakerEnabled: true,
  circuitBreakerName: '',
  fallbackPath: '/fallback/default'
})

onMounted(async () => {
  await store.fetchRoutes()
})

async function saveRoute() {
  const payload: RouteRule = {
    ...routeForm,
    id: routeForm.id.trim()
  }
  await store.saveRoute(payload)
}

async function removeRoute(id: string) {
  await store.deleteRoute(id)
}
</script>

