<template>
  <div class="max-w-4xl mx-auto space-y-12 animate-in fade-in duration-300">
    <div>
      <h2 class="text-xl font-semibold tracking-tight text-slate-100">路由配置</h2>
      <p class="text-xs text-slate-500 mt-1">动态管理 API 网关的流量分发规则、路径重写与熔断降级策略。</p>
    </div>

    <div class="space-y-5">
      <div class="flex items-center justify-between border-b border-slate-900 pb-3">
        <h3 class="text-sm font-medium text-slate-200">新建或覆盖路由规则</h3>
      </div>
      
      <form class="space-y-8 rounded-xl border border-slate-900 bg-[#0b0f19]/30 p-6" @submit.prevent="saveRoute">
        
        <div class="grid grid-cols-1 md:grid-cols-3 gap-5">
          <div class="space-y-1.5">
            <label class="text-[11px] font-medium uppercase tracking-wider text-slate-500">路由 ID (可选)</label>
            <input v-model="routeForm.id" class="w-full rounded-md border border-slate-900 bg-[#0a0e17] px-3 py-2 text-xs font-mono text-slate-100 outline-none transition-all focus:border-indigo-500/80 focus:ring-1 focus:ring-indigo-500/20 placeholder-slate-700" placeholder="e.g. user-service" />
          </div>
          <div class="space-y-1.5">
            <label class="text-[11px] font-medium uppercase tracking-wider text-slate-500">匹配路径 (Path)<span class="text-rose-500 ml-1">*</span></label>
            <input v-model="routeForm.path" required class="w-full rounded-md border border-slate-900 bg-[#0a0e17] px-3 py-2 text-xs font-mono text-slate-100 outline-none transition-all focus:border-indigo-500/80 focus:ring-1 focus:ring-indigo-500/20 placeholder-slate-700" placeholder="e.g. /proxy/**" />
          </div>
          <div class="space-y-1.5">
            <label class="text-[11px] font-medium uppercase tracking-wider text-slate-500">目标地址 (URI)<span class="text-rose-500 ml-1">*</span></label>
            <input v-model="routeForm.uri" required class="w-full rounded-md border border-slate-900 bg-[#0a0e17] px-3 py-2 text-xs font-mono text-slate-100 outline-none transition-all focus:border-indigo-500/80 focus:ring-1 focus:ring-indigo-500/20 placeholder-slate-700" placeholder="e.g. https://httpbin.org" />
          </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-8 pt-6 border-t border-slate-900/50">
          
          <div class="space-y-5">
            <div class="flex items-center justify-between">
              <div>
                <div class="text-xs font-medium text-slate-200">路径重写 (Rewrite)</div>
                <div class="text-[10px] text-slate-500 mt-0.5">将请求路径正则替换后转发。</div>
              </div>
              <label class="relative inline-flex cursor-pointer items-center">
                <input v-model="routeForm.rewriteEnabled" type="checkbox" class="peer sr-only" />
                <div class="h-4 w-7 rounded-full bg-slate-800 transition-colors after:absolute after:left-[2px] after:top-[2px] after:h-3 after:w-3 after:rounded-full after:bg-slate-400 after:transition-all after:content-[''] peer-checked:bg-indigo-600 peer-checked:after:bg-white peer-checked:after:translate-x-full"></div>
              </label>
            </div>
            
            <div class="space-y-4 transition-opacity duration-300" :class="routeForm.rewriteEnabled ? 'opacity-100' : 'opacity-40 pointer-events-none'">
              <div class="space-y-1.5">
                <label class="text-[11px] font-medium uppercase tracking-wider text-slate-500">重写正则 (Regex)</label>
                <input v-model="routeForm.rewriteRegex" class="w-full rounded-md border border-slate-900 bg-[#0a0e17] px-3 py-2 text-xs font-mono text-slate-100 outline-none transition-all focus:border-indigo-500/80 focus:ring-1 focus:ring-indigo-500/20" />
              </div>
              <div class="space-y-1.5">
                <label class="text-[11px] font-medium uppercase tracking-wider text-slate-500">替换目标 (Replacement)</label>
                <input v-model="routeForm.rewriteReplacement" class="w-full rounded-md border border-slate-900 bg-[#0a0e17] px-3 py-2 text-xs font-mono text-slate-100 outline-none transition-all focus:border-indigo-500/80 focus:ring-1 focus:ring-indigo-500/20" />
              </div>
            </div>
          </div>

          <div class="space-y-5">
            <div class="flex items-center justify-between">
              <div>
                <div class="text-xs font-medium text-slate-200">熔断保护 (Circuit Breaker)</div>
                <div class="text-[10px] text-slate-500 mt-0.5">当后端服务异常时执行降级。</div>
              </div>
              <label class="relative inline-flex cursor-pointer items-center">
                <input v-model="routeForm.circuitBreakerEnabled" type="checkbox" class="peer sr-only" />
                <div class="h-4 w-7 rounded-full bg-slate-800 transition-colors after:absolute after:left-[2px] after:top-[2px] after:h-3 after:w-3 after:rounded-full after:bg-slate-400 after:transition-all after:content-[''] peer-checked:bg-indigo-600 peer-checked:after:bg-white peer-checked:after:translate-x-full"></div>
              </label>
            </div>

            <div class="space-y-4 transition-opacity duration-300" :class="routeForm.circuitBreakerEnabled ? 'opacity-100' : 'opacity-40 pointer-events-none'">
              <div class="space-y-1.5">
                <label class="text-[11px] font-medium uppercase tracking-wider text-slate-500">熔断器名称</label>
                <input v-model="routeForm.circuitBreakerName" class="w-full rounded-md border border-slate-900 bg-[#0a0e17] px-3 py-2 text-xs font-mono text-slate-100 outline-none transition-all focus:border-indigo-500/80 focus:ring-1 focus:ring-indigo-500/20" />
              </div>
              <div class="space-y-1.5">
                <label class="text-[11px] font-medium uppercase tracking-wider text-slate-500">降级路径 (Fallback Path)</label>
                <input v-model="routeForm.fallbackPath" class="w-full rounded-md border border-slate-900 bg-[#0a0e17] px-3 py-2 text-xs font-mono text-slate-100 outline-none transition-all focus:border-indigo-500/80 focus:ring-1 focus:ring-indigo-500/20" />
              </div>
            </div>
          </div>

        </div>

        <div class="flex items-center justify-end pt-2">
          <button type="submit" class="rounded-md bg-slate-100 px-4 py-2 text-xs font-semibold text-slate-950 transition-all hover:bg-slate-200 active:scale-[0.98] shadow-md">
            保存配置
          </button>
        </div>
      </form>
    </div>

    <div class="space-y-4 pt-6">
      <div class="flex items-center justify-between border-b border-slate-900 pb-3">
        <h3 class="text-sm font-medium text-slate-200">生效中的路由</h3>
        <span class="text-xs text-slate-500">{{ store.routes.length }} 规则已加载</span>
      </div>

      <div v-if="store.routes.length === 0" class="flex h-24 items-center justify-center rounded-xl border border-dashed border-slate-800 bg-[#0b0f19]/20 text-xs text-slate-500 italic">
        暂无路由规则。请在上方添加以开始代理流量。
      </div>

      <div v-else class="space-y-2">
        <div 
          v-for="route in store.routes" 
          :key="route.id" 
          class="group flex items-center justify-between rounded-lg border border-slate-900 bg-[#0b0f19]/40 px-4 py-3 transition-colors hover:border-slate-800 hover:bg-[#0b0f19]"
        >
          <div class="flex items-center gap-4 overflow-hidden">
            <span class="flex-shrink-0 text-xs font-bold text-slate-300">{{ route.id }}</span>
            <div class="flex items-center gap-2 text-[11px] font-mono">
              <span class="rounded bg-indigo-500/10 px-1.5 py-0.5 text-indigo-400">{{ route.path }}</span>
              <span class="text-slate-600">→</span>
              <span class="truncate text-slate-400">{{ route.uri }}</span>
            </div>
          </div>
          <button 
            @click="removeRoute(route.id)" 
            class="ml-4 flex-shrink-0 text-[11px] font-medium text-slate-600 transition-colors hover:text-rose-500"
          >
            删除
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive } from 'vue'
import { useTrafficStore, type RouteRule } from '../stores/traffic'

const store = useTrafficStore()

// 保持了你原有的默认 mock 数据，方便测试
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
  if (confirm('确定要删除这条路由规则吗？')) {
    await store.deleteRoute(id)
  }
}
</script>