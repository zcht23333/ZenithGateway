<script setup lang="ts">
import { computed, type UnwrapNestedRefs } from 'vue'
import type { SettingsEditor } from '../settings/editor'
import { fields, displayValue } from '../settings/model'
import { timeLabel } from '../overview/model'
import RouteIcon from './RouteIcon.vue'
const props=defineProps<{editor:UnwrapNestedRefs<SettingsEditor>}>()
const state=computed(()=>props.editor.state)
const preview=computed(()=>state.value.rollbackPreview)
function confirmRollback() {
  if(!props.editor.canRollback || !preview.value)return
  const source=preview.value.source.version.split(':')[1]
  const draft=props.editor.dirty ? '当前未保存草稿不参与此次恢复；成功后将替换这份草稿，失败则继续保留。' : ''
  if(window.confirm('确认将版本 '+source+' 提交完成后的完整六项参数恢复为新版本？版本会继续递增。'+draft))void props.editor.rollback()
}
</script>
<template>
  <section v-if="state.historyOpen" class="settings-history" aria-labelledby="settings-history-title">
    <header class="settings-history-heading"><div><p>配置时间线</p><h2 id="settings-history-title">选择来源，核对后恢复</h2><span>恢复完整六字段 · 生成新版本 · 保留原提交记录</span></div>
      <button class="zenith-button" :disabled="state.saving || state.querying || state.operationStatus==='unknown'" @click="editor.closeHistory()">关闭历史核对</button>
    </header>
    <div class="settings-history-layout">
      <div class="settings-history-directory">
        <div class="settings-history-toolbar"><strong>成功提交历史</strong><button class="zenith-text-button" :disabled="state.historyLoading || state.saving" @click="editor.loadHistory()">{{ state.historyLoading ? '读取中…' : '最新记录' }}</button></div>
        <p class="settings-history-retention">最多 100 条 · 7 天内<br/>最近查询 {{ timeLabel(state.historyCheckedAt) }}</p>
        <p v-if="state.historyError" role="alert" class="settings-history-error">{{ state.historyError }}<button class="zenith-text-button" @click="editor.loadHistory(state.historyCursor)">重试历史查询</button></p>
        <div v-if="state.historyLoading" role="status" class="settings-history-status">正在读取成功提交记录…</div>
        <div v-else-if="!state.historyEntries.length && !state.historyError" class="settings-history-status">暂无可用历史。初始化不是一次成功提交，过期记录也不会作为恢复来源。</div>
        <div class="settings-history-list" :aria-busy="state.historyLoading">
          <button v-for="entry in state.historyEntries" :key="entry.operationId" type="button" class="settings-history-row"
            :class="{'is-selected':state.rollbackSource?.operationId===entry.operationId}" :aria-pressed="state.rollbackSource?.operationId===entry.operationId"
            :disabled="state.saving || state.querying || state.loading || state.operationStatus==='unknown'"
            :title="entry.after!.version+' · '+entry.operationId" @click="editor.previewRollback({version:entry.after!.version,operationId:entry.operationId})">
            <span><b>版本 {{ entry.after!.version.split(':')[1] }}</b><em>{{ entry.operationType==='rollback' ? '历史恢复' : '参数修改' }}</em></span>
            <time>{{ timeLabel(entry.recordedAt,true) }}</time><small>{{ entry.operationId }}</small>
          </button>
        </div>
        <button v-if="state.historyNextCursor" class="zenith-button settings-history-next" :disabled="state.historyLoading || state.saving" @click="editor.loadHistory(state.historyNextCursor!)">较早记录 <RouteIcon name="arrow" :size="16" /></button>
      </div>
      <div class="settings-rollback-review" aria-label="历史恢复核对">
        <p v-if="editor.dirty" class="settings-history-draft-note">当前编辑草稿仍保留。选择历史不会覆盖它；确认恢复时会再次说明如何处理。</p>
        <p v-if="state.rollbackLoading" role="status">正在向服务端核实来源与当前完整配置…</p>
        <div v-if="state.rollbackError" role="alert" class="settings-rollback-error"><strong>恢复尚未完成</strong><p>{{ state.rollbackError }}</p><button v-if="state.rollbackSource" class="zenith-button" :disabled="state.rollbackLoading || state.saving || state.querying || state.operationStatus==='unknown'" @click="editor.previewRollback(state.rollbackSource)">重新读取恢复预览</button></div>
        <template v-if="preview">
          <header class="settings-rollback-heading"><div><span>预览时当前版本 {{ preview.current.version.split(':')[1] }}</span><h3>恢复版本 {{ preview.source.version.split(':')[1] }} 的参数</h3><p>来源记录于 {{ timeLabel(preview.source.recordedAt,true) }}</p></div><span class="settings-rollback-badge">提交为新版本</span></header>
          <div v-if="!state.rollbackError" class="settings-rollback-refresh"><span>{{ preview.current.version!==state.current?.version ? '当前已确认版本已变化，请重新核对这份预览。' : '预览读取于 '+timeLabel(preview.checkedAt,true) }}</span><button class="zenith-text-button" :disabled="state.saving || state.querying || state.rollbackLoading || state.operationStatus==='unknown'" @click="editor.previewRollback(preview.source)">重新核对当前值</button></div>
          <p v-if="preview.noChanges" class="settings-rollback-no-changes" role="status">六项参数与当前值完全一致。确认后仍会生成新版本并记录恢复来源。</p>
          <table class="settings-rollback-differences"><thead><tr><th scope="col">参数 / 单位</th><th scope="col">预览时当前值</th><th scope="col">历史目标值</th></tr></thead><tbody>
            <tr v-for="field in fields" :key="field.key" :class="{'is-changed':preview.current[field.key]!==preview.target[field.key]}"><th scope="row">{{ field.label }}<small>{{ field.unit }}</small></th><td>{{ displayValue(preview.current[field.key]) }}</td><td>{{ displayValue(preview.target[field.key]) }}<span class="zenith-sr-only">{{ preview.current[field.key]!==preview.target[field.key] ? '将修改' : '不变' }}</span></td></tr>
          </tbody></table>
          <details class="settings-history-identity"><summary>完整版本与来源 ID · 可查看和复制</summary><label>核对时的当前版本<input readonly :value="preview.current.version" aria-label="恢复预期版本" @focus="($event.target as HTMLInputElement).select()" /></label><label>恢复来源版本<input readonly :value="preview.source.version" aria-label="恢复来源版本" @focus="($event.target as HTMLInputElement).select()" /></label><label>来源操作 ID<input readonly :value="preview.source.operationId" aria-label="恢复来源操作 ID" @focus="($event.target as HTMLInputElement).select()" /></label></details>
          <label class="settings-rollback-ack"><input type="checkbox" v-model="state.rollbackReviewed" :disabled="state.saving || state.rollbackLoading || !!state.rollbackError || state.needsConfirmation || preview.current.version!==state.current?.version" />我已核对六项参数，确认恢复完整快照。</label>
          <button class="zenith-button is-primary settings-rollback-submit" :disabled="!editor.canRollback" @click="confirmRollback"><RouteIcon name="check" :size="18" />{{ state.saving ? '正在等待恢复确认…' : '确认恢复完整配置' }}</button>
          <p class="settings-history-footnote">提交时再次检查来源是否保留和当前版本是否变化。一次保存确认不代表所有实例已经采用。</p>
        </template>
        <div v-else-if="!state.rollbackLoading && !state.rollbackError" class="settings-history-empty"><RouteIcon name="sliders" :size="32" /><h3>选择一次成功提交</h3><p>核对它完成后的六项参数，再将这些值作为新版本提交。原版本与回执继续保留。</p></div>
      </div>
    </div>
  </section>
</template>
