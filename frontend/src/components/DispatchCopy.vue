<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import RouteIcon from './RouteIcon.vue'
const props = defineProps<{ value: string; label: string }>()
const state = ref<'idle' | 'done' | 'failed'>('idle')
let timer: ReturnType<typeof setTimeout> | undefined
async function copy() {
  try { await navigator.clipboard.writeText(props.value); state.value = 'done' }
  catch { state.value = 'failed' }
  clearTimeout(timer)
  timer = setTimeout(() => { state.value = 'idle' }, 2200)
}
onBeforeUnmount(() => clearTimeout(timer))
</script>
<template>
  <span class="dispatch-copy-wrap">
    <button type="button" class="dispatch-copy" :aria-label="'复制' + label" :title="state === 'done' ? '已复制' : '复制' + label" @click.stop="copy">
      <RouteIcon :name="state === 'done' ? 'check' : 'copy'" :size="16" />
    </button>
    <span class="dispatch-copy-result" role="status">{{ state === 'done' ? '已复制' : state === 'failed' ? '复制失败，请选择文字复制' : '' }}</span>
  </span>
</template>

<style scoped>
.dispatch-copy-wrap { display:inline-flex; position:relative; align-items:center; flex-shrink:0; }
.dispatch-copy { width:29px; height:29px; display:inline-flex; align-items:center; justify-content:center; border:1px solid transparent; color:inherit; border-radius:3px; opacity:.8; }
.dispatch-copy:hover { background:#52655926; border-color:#8b9a8577; opacity:1; }
.dispatch-copy-result:not(:empty) { position:absolute; right:0; bottom:calc(100% + 5px); padding:4px 7px; color:#e3f4c9; background:#24341e; border:1px solid #66744e; border-radius:3px; font-size:11px; white-space:nowrap; z-index:20; }
</style>
