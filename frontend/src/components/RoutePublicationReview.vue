<script setup lang="ts">
import type { RouteRule } from '../stores/traffic'
import type { RouteEditState } from '../routes/editor'
import { routeFields, routeValue } from '../routes/publication'
import DispatchCopy from './DispatchCopy.vue'
defineProps<{ state:RouteEditState; current:RouteRule|null }>()
defineEmits<{read:[];review:[]}>()
</script>
<template>
 <section v-if="state.reviewRequired" class="route-publication-review" aria-labelledby="route-review-title">
  <h3 id="route-review-title">{{ state.status==='conflict'?'版本冲突 · 核对后再次发布':state.status==='unknown'?'结果未知 · 重新核对当前状态':'认证恢复 · 重新核对' }}</h3>
  <p>核对基准 <code>{{ state.base?.version }}</code><DispatchCopy v-if="state.base" :value="state.base.version" label="核对基准版本" /></p>
  <p v-if="state.latest">当前存储 <code>{{ state.latest.version }}</code><DispatchCopy :value="state.latest.version" label="当前存储版本" /></p>
  <p v-if="state.status==='unknown'">本页没有路由操作回执，当前值相同也不能认定原提交成功。核对操作不会自动发布。</p>
  <p v-if="state.latest&&!current">当前存储中没有此 ID。{{ state.kind==='delete'?'此路由无需再次删除。':'再次提交将以此 ID 新建路由。' }}</p>
  <div class="route-review-table" v-if="state.latest"><table><thead><tr><th>字段</th><th>当前存储值</th><th>{{ state.kind==='delete'?'待删除内容':'待提交内容' }}</th></tr></thead><tbody>
   <tr v-for="field in routeFields" :key="field.key" :class="{'is-changed':current?.[field.key]!==state.draft[field.key]}"><th>{{ field.label }}</th><td><code>{{ current?routeValue(current[field.key]):'路由不存在' }}</code></td><td><code>{{ routeValue(state.draft[field.key]) }}</code></td></tr>
  </tbody></table></div>
  <p v-if="state.readError" role="alert">{{ state.readError }}</p>
  <div class="route-review-actions"><button type="button" class="orbit-button" :disabled="state.reading||state.saving" @click="$emit('read')">{{ state.reading?'读取中…':'重新读取当前状态' }}</button>
   <button v-if="state.latest" type="button" class="orbit-button orbit-primary" :disabled="state.reading||state.saving||state.authExpired||!!state.readError||(state.kind==='delete'&&!current)" @click="$emit('review')">已核对，使用此版本</button></div>
 </section>
</template>
<style>
.orbit-editor:has(.route-publication-review){width:820px;max-width:100vw}

.route-publication-review{padding:18px;border:1px solid #c5a83d;border-radius:10px;background:#fffbec;color:#263130;margin-bottom:20px}.route-publication-review h3{font-size:18px;font-weight:700;margin:0 0 12px}.route-publication-review p{font-size:15px;line-height:1.65;overflow-wrap:anywhere}.route-publication-review code{font-size:13px;white-space:pre-wrap;overflow-wrap:anywhere}.route-review-table{overflow:auto;margin:14px 0}.route-review-table table{border-collapse:collapse;width:100%;table-layout:fixed;font-size:14px}.route-review-table th,.route-review-table td{text-align:left;padding:9px 7px;border-bottom:1px solid #dad9cf;vertical-align:top}.route-review-table th:first-child{width:22%}.route-review-table .is-changed{background:#eff6cf}.route-review-actions{display:flex;flex-wrap:wrap;gap:8px}
</style>
