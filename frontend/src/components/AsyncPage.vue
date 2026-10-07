<script setup lang="ts">
import { markRaw, onBeforeUnmount, shallowRef, ref, watch, type Component } from 'vue'
import ZenithHeader from './ZenithHeader.vue'
const props = defineProps<{ page:'overview'|'settings'|'routes'; preview?:boolean }>()
// Vue Router resolves this small host eagerly. Page imports only start after
// App's authentication gate mounts it, so login never downloads page engines.
const loaders = {
  overview:()=>import('../views/Dashboard.vue'),
  settings:()=>import('../views/Settings.vue'),
  routes:()=>import('../views/RouteDispatch.vue')
}
const view = shallowRef<Component>(), failed = ref(false)
let generation = 0
async function load() {
  const current = ++generation
  view.value = undefined; failed.value = false
  try {
    const module = await loaders[props.page]()
    if (current === generation) view.value = markRaw(module.default)
  } catch { if (current === generation) failed.value = true }
}
function reloadPage() { window.location.reload() }
watch(()=>props.page,load,{immediate:true})
onBeforeUnmount(()=>{generation++})
</script>
<template>
  <component :is="view" v-if="view" :preview="preview" />
  <template v-else>
    <ZenithHeader :preview="preview" />
    <main class="zenith-page-loading" :aria-busy="!failed">
      <h1>{{ {overview:'运行概览',settings:'系统配置',routes:'路由调度'}[page] }}</h1>
      <p role="status">{{ failed ? '页面资源加载失败。请检查连接后重新载入。' : '正在载入页面…' }}</p>
      <button v-if="failed" class="zenith-button" @click="reloadPage">重新载入页面</button>
    </main>
  </template>
</template>
