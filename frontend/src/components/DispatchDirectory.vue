<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { RouteRule } from '../stores/traffic'
import RouteIcon from './RouteIcon.vue'
import '../styles/route-directory.css'

const props = defineProps<{
  rows: RouteRule[]
  total: number
  selectedId: string
  order: Map<string, number>
  stale: boolean
}>()
const search = defineModel<string>('search', { required:true })
const filter = defineModel<string>('filter', { required:true })
const emit = defineEmits<{ select: [id: string]; 'open-change': [value: boolean]; reset: [] }>()
const dialog = ref<HTMLDialogElement>(), input = ref<HTMLInputElement>(), scroll = ref<HTMLElement>()

async function open() {
  if (dialog.value?.open) return
  dialog.value?.showModal()
  emit('open-change', true)
  await nextTick()
  input.value?.focus({preventScroll:true})
  document.getElementById('dispatch-all-' + props.selectedId)?.scrollIntoView({block:'nearest'})
}
function choose(id: string) {
  dialog.value?.close()
  emit('select', id)
}
function firstResult() { if (props.rows[0]) choose(props.rows[0].id) }
async function navigate(event: KeyboardEvent, index: number) {
  if (!['ArrowUp','ArrowDown','Home','End'].includes(event.key)) return
  event.preventDefault()
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? props.rows.length - 1 :
    index + (event.key === 'ArrowDown' ? 1 : -1)
  const row = props.rows[next]
  if (row) document.getElementById('dispatch-all-' + row.id)?.focus()
}
watch([search, filter], async () => {
  await nextTick()
  if (scroll.value) scroll.value.scrollTop = 0
})
onBeforeUnmount(() => dialog.value?.close())
defineExpose({ open })
</script>

<template>
  <dialog id="dispatch-all-routes" ref="dialog" class="dispatch-directory-dialog" aria-labelledby="dispatch-all-title" @close="emit('open-change',false)" @keydown.esc.stop.prevent="dialog?.close()">
    <header class="dispatch-directory-header">
      <div><h2 id="dispatch-all-title">全部路由 <span>{{ rows.length }}<small v-if="rows.length !== total"> / {{ total }}</small></span></h2><p>比较完整 ID、入口与目标，点击路由 ID 返回处理路径。</p></div>
      <span v-if="stale" class="dispatch-directory-stale">缓存配置</span>
      <button class="dispatch-icon-button" aria-label="关闭全部路由" @click="dialog?.close()"><RouteIcon name="close" /></button>
    </header>
    <div class="dispatch-directory-tools">
      <label class="dispatch-directory-search"><RouteIcon name="search" :size="19" /><input ref="input" v-model="search" type="search" placeholder="搜索路由 ID、Path 或目标地址" aria-label="搜索全部路由" @keydown.enter.prevent="firstResult" /></label>
      <label class="dispatch-directory-filter"><RouteIcon name="filter" :size="17" /><select v-model="filter" aria-label="筛选全部路由的处理规则"><option value="all">全部处理规则</option><option value="rewrite">启用路径重写</option><option value="breaker">启用熔断保护</option><option value="plain">无重写及熔断</option></select></label>
      <button v-if="search || filter !== 'all'" class="dispatch-directory-clear" @click="emit('reset')">清除筛选</button>
    </div>
    <div ref="scroll" class="dispatch-directory-scroll">
      <table v-if="rows.length" class="dispatch-directory-table">
        <colgroup><col class="directory-col-number" /><col class="directory-col-id" /><col class="directory-col-path" /><col class="directory-col-uri" /></colgroup>
        <thead><tr><th scope="col">目录</th><th scope="col">路由 ID</th><th scope="col">入口 · Path</th><th scope="col">目标 · URI</th></tr></thead>
        <tbody>
          <tr v-for="(row,index) in rows" :key="row.id" :class="{ 'is-current':row.id === selectedId }">
            <td class="dispatch-directory-number">{{ String(order.get(row.id) ?? index + 1).padStart(2,'0') }}</td>
            <th scope="row"><button :id="'dispatch-all-' + row.id" class="dispatch-directory-select" :aria-label="'选择路由 ' + row.id" :aria-current="row.id === selectedId ? 'true' : undefined" @click="choose(row.id)" @keydown="navigate($event,index)"><strong>{{ row.id }}</strong><span v-if="row.id === selectedId" class="dispatch-directory-current">当前</span><RouteIcon name="arrow" :size="16" /></button></th>
            <td data-label="入口 · Path"><code>{{ row.path }}</code></td>
            <td data-label="目标 · URI"><code>{{ row.uri }}</code></td>
          </tr>
        </tbody>
      </table>
      <div v-else class="dispatch-directory-empty"><RouteIcon name="search" :size="32" /><h3>{{ total ? '没有匹配的路由' : '目录为空' }}</h3><p>搜索和筛选不会改变当前画布。</p><button v-if="search || filter !== 'all'" @click="emit('reset')">清除筛选</button></div>
    </div>
    <footer class="dispatch-directory-footer"><span>显示 {{ rows.length }} / {{ total }} 条</span><span>↑ ↓ 浏览 · Enter 选择 · Esc 关闭</span></footer>
  </dialog>
</template>
