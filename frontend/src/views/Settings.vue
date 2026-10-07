<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch, type UnwrapNestedRefs } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import ZenithHeader from '../components/ZenithHeader.vue'
import SettingsHistory from '../components/SettingsHistory.vue'
import RouteIcon from '../components/RouteIcon.vue'
import { useSettingsStore, type SettingsEditor } from '../settings/editor'
import { confirmSettingsLeave } from '../settings/leave'
import { createSettingsPreview, settingsScene, settingsScenes } from '../settings/preview'
import { displayValue, fields, numericFields, type NumericKey } from '../settings/model'
import { timeLabel } from '../overview/model'
import '../styles/settings.css'

const props = withDefaults(defineProps<{preview?:boolean}>(),{preview:false})
const route = useRoute(), router = useRouter()
const scene = computed(()=>settingsScene(route.query.scenario))
const editor = shallowRef<UnwrapNestedRefs<SettingsEditor>>(props.preview
  ? reactive(createSettingsPreview(scene.value)) : useSettingsStore())
const state = computed(()=>editor.value.state)
const locked = computed(()=>!state.value.current || state.value.loading || state.value.saving)
const differences = computed(()=>fields.filter(field=>editor.value.changes.includes(field.key)))
const trafficFields = numericFields.filter(field=>field.group==='traffic')
const monitorFields = numericFields.filter(field=>field.group==='monitor')
const combinationWarning = computed(()=>{
  const draft = state.value.draft, errors = editor.value.errors
  return !errors.burstCapacity && !errors.requestedTokens && state.value.current &&
    Number(draft.requestedTokens) > Number(draft.burstCapacity)
})
const statusText = computed(()=>state.value.saving ? '正在等待保存确认' : state.value.loading ? '正在读取配置' :
  state.value.writeStatus==='committed-unadopted' ? '存储已写入 · 本实例采用待处理' : state.value.needsConfirmation ? state.value.writeStatus==='uncertain' ? '写入结果待确认' : '配置版本待核对' : state.value.readError ? state.value.current ? '重新读取失败 · 保留已确认值' : '配置读取失败' :
  state.value.reviewRequired ? '版本已更新 · 请核对草稿' : state.value.writeStatus==='rejected' ? '保存被拒绝 · 草稿保留' : editor.value.dirty ? '有未保存修改' :
  state.value.writeStatus==='confirmed' ? '保存已确认' : state.value.current ? '当前配置已读取' : '尚未读取配置')
const saveLabel = computed(()=>state.value.saving ? '保存中…' : state.value.rollbackSource ? '请先完成或关闭历史恢复' : !state.value.current ? '读取后才能保存' : state.value.needsConfirmation ? '请先读取确认' : state.value.readError ? '请先重试读取' :
  state.value.reviewRequired ? '请先核对最新版本' : Object.keys(editor.value.errors).length ? '请先修正输入' : editor.value.dirty ? '保存 '+differences.value.length+' 项修改' : '暂无待保存修改')
const reviewTitle = ref<HTMLHeadingElement>()
function reviewChanges() {
  reviewTitle.value?.focus({preventScroll:true})
  reviewTitle.value?.scrollIntoView({block:'start',behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'})
}
function edit(key:NumericKey,event:Event) { editor.value.edit(key,(event.target as HTMLInputElement).value) }
function finishUnknown() {
  if(window.confirm('原提交仍可能已经执行。结束确认不会重发；请重新核对当前值，再决定是否以新操作 ID 提交。')) editor.value.finishUnknown()
}
function leave() { return confirmSettingsLeave(editor.value) }
onBeforeRouteLeave(()=>props.preview ? leave() : true)
function beforeUnload(event:BeforeUnloadEvent) {
  if (props.preview && editor.value.protectedDraft) { event.preventDefault(); event.returnValue='' }
}
onMounted(()=>{void editor.value.load();window.addEventListener('beforeunload',beforeUnload)})
onBeforeUnmount(()=>{editor.value.cancelRead();editor.value.cancelHistoryReads();window.removeEventListener('beforeunload',beforeUnload)})
watch(scene,value=>{
  if (!props.preview) return
  editor.value.cancelRead();editor.value.cancelHistoryReads();editor.value=reactive(createSettingsPreview(value));void editor.value.load()
})
async function setScene(event:Event) {
  const select = event.target as HTMLSelectElement
  if (!leave()) {select.value=scene.value;return}
  await router.replace({query:{scenario:select.value}})
}
</script>
<template>
  <div class="settings-view">
    <ZenithHeader :preview="preview" :before-disconnect="leave" />
    <div v-if="preview" class="settings-demo-bar"><span>演示数据 · 修改仅在本页有效</span><label>场景 <select aria-label="配置演示场景" :value="scene" :disabled="state.saving" @change="setScene"><option v-for="item in settingsScenes" :key="item.id" :value="item.id">{{ item.label }}</option></select></label></div>
    <main class="settings-workspace">
      <header class="settings-heading">
        <div><h1>系统配置</h1><p>看清当前值，核对变更，再交给网关执行。</p></div>
        <div class="settings-read-state" :class="{'is-attention':state.readError || state.needsConfirmation || state.writeStatus==='rejected' || state.reviewRequired}">
          <span role="status"><i />{{ statusText }}</span>
          <time :title="timeLabel(state.loadedAt,true)">最近确认 {{ timeLabel(state.loadedAt) }}</time>
        </div>
        <button class="zenith-button settings-refresh" :disabled="state.loading || state.saving" @click="editor.load()"><RouteIcon name="refresh" :size="17" />{{ state.needsConfirmation ? '读取当前配置' : state.readError ? '重试读取配置' : '重新读取' }}</button>
      </header>
      <div v-if="state.readError" class="settings-read-error" role="alert"><RouteIcon name="alert" :size="20" /><div><strong>{{ state.current ? state.writeStatus==='confirmed' ? '保存已确认，重新读取失败' : '重新读取失败，保留已确认值与草稿' : '尚未取得配置，请重试读取' }}</strong><p>{{ state.readError }}<template v-if="!state.current">。读取成功后才能编辑和保存。</template></p></div></div>
      <div v-if="editor.historySupported && !state.historyOpen" class="settings-history-entry"><button class="zenith-button" :disabled="state.saving" @click="editor.loadHistory()"><RouteIcon name="sliders" :size="17" />提交历史 / 安全恢复</button><span>从成功历史恢复完整参数，版本继续递增。</span></div>
      <SettingsHistory :editor="editor" />
      <form class="settings-layout" novalidate @submit.prevent="editor.save()">
        <div class="settings-parameter-area">
          <button v-if="editor.dirty" type="button" class="settings-review-jump" aria-controls="settings-review-title" @click="reviewChanges"><span>已修改 {{ differences.length }} 项 · 查看变更</span><RouteIcon name="arrow" :size="18" /></button>
          <section class="settings-paper" aria-labelledby="settings-traffic-title">
            <header class="settings-group-heading settings-traffic-heading"><div class="settings-section-icon"><RouteIcon name="sliders" :size="23" /></div><div><h2 id="settings-traffic-title">流量控制</h2><p>统一开关，每个 IP 使用独立的令牌桶。</p></div>
              <div class="settings-limit-switch"><label id="rateLimitEnabled-label">全局限流</label><div class="settings-toggle-control"><span class="settings-current-value">当前 {{ displayValue(state.current?.rateLimitEnabled) }}</span><button type="button" role="switch" aria-labelledby="rateLimitEnabled-label" :aria-checked="state.draft.rateLimitEnabled===true" :disabled="locked" class="settings-switch" :class="{'is-on':state.draft.rateLimitEnabled===true,'is-changed':editor.changes.includes('rateLimitEnabled')}" @click="editor.edit('rateLimitEnabled',!state.draft.rateLimitEnabled)"><span class="settings-switch-track"><i /></span>{{ displayValue(state.draft.rateLimitEnabled) }}</button></div></div>
            </header>
            <div class="settings-fields is-traffic">
              <div v-for="field in trafficFields" :key="field.key" class="settings-field" :class="{'is-changed':editor.changes.includes(field.key),'has-error':editor.errors[field.key]}">
                <label :for="'setting-'+field.key">{{ field.label }}</label><p :id="field.key+'-description'">{{ field.description }}</p>
                <div class="settings-input"><input :id="'setting-'+field.key" :value="state.draft[field.key]" type="text" inputmode="numeric" autocomplete="off" spellcheck="false" placeholder="—" :disabled="locked" :aria-invalid="!!editor.errors[field.key]" :aria-describedby="field.key+'-description '+field.key+'-help'" @input="edit(field.key,$event)" /><span>{{ field.unit }}</span></div>
                <div class="settings-field-meta"><span>当前 <b>{{ displayValue(state.current?.[field.key]) }}</b></span><span>1–{{ field.max.toLocaleString('en-US') }} · 整数</span></div>
                <p v-if="editor.errors[field.key]" :id="field.key+'-help'" class="settings-field-error" role="alert">{{ editor.errors[field.key] }}</p><span v-else :id="field.key+'-help'" class="zenith-sr-only">有效范围为 1 到 {{ field.max }} 的整数，单位 {{ field.unit }}</span>
              </div>
            </div>
            <p v-if="combinationWarning" class="settings-combination-warning" role="status"><RouteIcon name="alert" :size="18" /><span>单次消耗大于桶容量。在令牌桶正常执行时，即使桶已满也无法放行请求；请核对这组参数。</span></p>
            <div class="settings-group-note"><RouteIcon name="info" :size="17" /><p><template v-if="state.draft.rateLimitEnabled===false">限流关闭后，参数仍保留，重新开启时使用。</template><template v-else>令牌足够时放行，否则返回 HTTP 429。</template> 补充速率是令牌/秒，不等于可通过的每秒请求数。</p></div>
          </section>
          <section class="settings-paper" aria-labelledby="settings-monitor-title">
            <header class="settings-group-heading"><div class="settings-section-icon"><RouteIcon name="activity" :size="23" /></div><div><h2 id="settings-monitor-title">监控采样</h2><p>分别控制统计范围与快照更新节奏。</p></div><span class="settings-group-label">窗口与间隔</span></header>
            <div class="settings-fields is-monitor">
              <div v-for="field in monitorFields" :key="field.key" class="settings-field" :class="{'is-changed':editor.changes.includes(field.key),'has-error':editor.errors[field.key]}">
                <label :for="'setting-'+field.key">{{ field.label }}</label><p :id="field.key+'-description'">{{ field.description }}</p>
                <div class="settings-input"><input :id="'setting-'+field.key" :value="state.draft[field.key]" type="text" inputmode="numeric" autocomplete="off" spellcheck="false" placeholder="—" :disabled="locked" :aria-invalid="!!editor.errors[field.key]" :aria-describedby="field.key+'-description '+field.key+'-help'" @input="edit(field.key,$event)" /><span>{{ field.unit }}</span></div>
                <div class="settings-field-meta"><span>当前 <b>{{ displayValue(state.current?.[field.key]) }}</b></span><span>1–{{ field.max }} · 整数</span></div>
                <p v-if="editor.errors[field.key]" :id="field.key+'-help'" class="settings-field-error" role="alert">{{ editor.errors[field.key] }}</p><span v-else :id="field.key+'-help'" class="zenith-sr-only">有效范围为 1 到 {{ field.max }} 的整数，单位 {{ field.unit }}</span>
              </div>
            </div>
            <div class="settings-group-note"><RouteIcon name="info" :size="17" /><p>窗口决定指标覆盖多久，间隔决定多久更新一次；趋势仍按实际采样时间显示。</p></div>
          </section>
        </div>
        <aside class="settings-review" aria-labelledby="settings-review-title">
          <header><p>核对后提交</p><h2 id="settings-review-title" ref="reviewTitle" tabindex="-1">变更摘要 <span>{{ differences.length }}</span></h2></header>
          <section v-if="state.reviewRequired" class="settings-version-conflict" role="alert" aria-label="版本冲突核对">
            <strong>最新值与待核对基准</strong>
            <p>下方变更摘要保留你的修改。未修改字段已采用最新值，请核对后再提交。</p>
            <div v-for="change in state.remoteChanges" :key="change.key" class="settings-remote-change"><span>{{ fields.find(f=>f.key===change.key)?.label }}</span><b>{{ displayValue(change.before) }} → {{ displayValue(change.latest) }}</b></div>
            <p v-if="!state.remoteChanges.length">{{ state.reviewBaseline ? '与待核对基准相比，六个参数的值一致。' : '尚无可比较的先前基准，请核对当前值与草稿。' }}</p>
          </section>
          <div class="settings-review-columns"><span>当前已确认</span><RouteIcon name="arrow" :size="18" /><span>待保存</span></div>
          <div v-if="differences.length" class="settings-differences" aria-live="polite">
            <div v-for="field in differences" :key="field.key" class="settings-difference" :class="{'has-error':editor.errors[field.key]}"><h3>{{ field.label }} <small>{{ field.unit }}</small></h3><div><span>{{ displayValue(state.current?.[field.key]) }}</span><RouteIcon name="arrow" :size="18" /><strong>{{ displayValue(state.draft[field.key]) }}</strong></div><p v-if="editor.errors[field.key]">输入待修正</p></div>
          </div>
          <div v-else class="settings-no-changes"><RouteIcon :name="state.current ? 'check' : 'sliders'" :size="30" /><strong>{{ state.current ? '与已确认值一致' : state.loading ? '等待读取当前配置' : '尚未建立配置基准' }}</strong><p>{{ state.current ? '修改左侧参数后，这里只列出发生变化的字段。' : '读取成功后建立基准，不使用本地默认值代替。' }}</p></div>
          <div v-if="state.writeMessage" class="settings-write-message" :class="'is-'+state.writeStatus" role="status"><RouteIcon :name="state.writeStatus==='confirmed' || state.writeStatus==='reconciled' ? 'check' : 'alert'" :size="19" /><p>{{ state.writeMessage }}</p></div>
          <p v-if="state.saving" class="settings-saving-note" role="status">正在提交六个参数，等待服务端确认。输入暂时锁定，避免草稿被覆盖。</p>
          <section v-if="state.operation" class="settings-operation" aria-label="本次提交回执">
            <strong v-if="state.receipt?.operationType==='rollback'" class="settings-rollback-receipt">历史恢复回执 · 来源版本 {{ state.receipt.source?.version.split(':')[1] }}</strong>
            <p v-if="state.receipt?.source">来源操作 {{ state.receipt.source.operationId }}</p>
            <label>本次操作 ID<input readonly :value="state.operation.operationId" aria-label="操作 ID" @focus="($event.target as HTMLInputElement).select()" /></label>
            <p v-if="state.operationMessage" role="status">{{ state.operationMessage }}</p>
            <p v-if="state.receipt">记录于 {{ timeLabel(state.receipt.recordedAt,true) }} · 回执保证保留至 {{ timeLabel(state.receipt.expiresAt,true) }}</p>
            <button type="button" class="zenith-button settings-query-operation" :disabled="state.querying || locked" @click="editor.queryOperation()">{{ state.querying ? '正在查询…' : '查询本次提交结果' }}</button>
            <button v-if="state.operationStatus==='unknown' && state.operationMessage && !state.querying" type="button" class="zenith-text-button" :disabled="locked || !!state.readError || state.authExpired" @click="finishUnknown">结束确认，保留草稿</button>
          </section>
          <button v-if="state.needsConfirmation" type="button" class="zenith-button settings-confirm-read" :disabled="state.loading || state.saving" @click="editor.load()"><RouteIcon name="refresh" :size="17" />{{ state.loading ? '正在读取确认…' : '读取服务端当前值' }}</button>
          <button v-if="state.reviewRequired" type="button" class="zenith-button settings-review-ack" :disabled="locked || state.needsConfirmation || !!state.readError" @click="editor.acknowledgeReview()">已核对，允许再次提交</button>
          <button type="submit" class="zenith-button is-primary settings-save" :disabled="!editor.canSave"><RouteIcon name="check" :size="19" />{{ saveLabel }}</button>
          <button type="button" class="zenith-text-button settings-restore" :disabled="!editor.dirty || locked || state.needsConfirmation" @click="editor.restore()">恢复当前已确认值</button>
          <details v-if="state.current" class="settings-version-details"><summary>存储已确认版本 · {{ state.current.version.split(':')[1] }}</summary><label>最近读取或提交确认<input readonly :value="state.current.version" aria-label="存储已确认版本" @focus="($event.target as HTMLInputElement).select()" /></label><label>本实例已采用<input readonly :value="state.adopted?.version || '尚未确认'" aria-label="本实例已采用版本" @focus="($event.target as HTMLInputElement).select()" /></label><label v-if="state.reviewBaseline">待核对比较基准<input readonly :value="state.reviewBaseline.version" aria-label="待核对基准版本" @focus="($event.target as HTMLInputElement).select()" /></label><label v-if="state.submittedVersion">最近提交所基于的版本<input readonly :value="state.submittedVersion" aria-label="最近提交的预期版本" @focus="($event.target as HTMLInputElement).select()" /></label><p>选中文本可复制完整版本。Redis 读取只确认当时的存储状态，不证明更早的请求是否执行。</p></details>
          <footer class="settings-confirmation"><span>服务端确认</span><strong>{{ state.savedAt ? '最近保存 '+timeLabel(state.savedAt) : state.loadedAt ? '最近读取 '+timeLabel(state.loadedAt) : '尚未取得确认' }}</strong><p>{{ state.savedAt ? '已确认的保存不会因后续读取失败而被撤销。' : '保存成功后，以服务端返回的有效值更新当前配置。' }}</p></footer>
        </aside>
      </form>
      <p class="settings-page-note">当前值来自最近一次 Redis 读取或提交确认。版本冲突保留草稿；核对后再次保存，仍会检查版本。</p>
    </main>
  </div>
</template>
