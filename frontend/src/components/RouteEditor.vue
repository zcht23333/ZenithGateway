<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import type { RouteRule } from '../stores/traffic'
import RouteIcon from './RouteIcon.vue'
import RoutePublicationReview from './RoutePublicationReview.vue'
import type { RouteEditState } from '../routes/editor'
const props = defineProps<{ route: RouteRule | null; saving: boolean; error: string; preview: boolean; draft?:RouteRule; publication?:RouteEditState; current?:RouteRule|null; canSubmit?:boolean }>()
const emit = defineEmits<{ close: []; save: [route: RouteRule]; read:[]; review:[] }>()
const dialog = ref<HTMLDialogElement>()
const localError = ref('')
const form = props.draft ?? reactive<RouteRule>(props.route ? { ...props.route, rewriteRegex: props.route.rewriteRegex ?? '', rewriteReplacement: props.route.rewriteReplacement ?? '/${segment}' } : {
  id: '', path: '/proxy/**', uri: '', rewriteEnabled: true, rewriteRegex: '',
  rewriteReplacement: '/${segment}', circuitBreakerEnabled: true,
  circuitBreakerName: '', fallbackPath: '/fallback/default'
})
onMounted(() => dialog.value?.showModal())
let disposing=false
onBeforeUnmount(() => { disposing=true; dialog.value?.close() })
function submit() {
  if (props.saving || props.canSubmit === false) return
  localError.value = ''
  if (form.id && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(form.id)) {
    localError.value = '路由 ID 需以字母或数字开头，只能包含字母、数字、点、下划线及连字符。'; return
  }
  if (!form.path.startsWith('/') || form.path.startsWith('//') || /[?#\s]/.test(form.path)) {
    localError.value = '匹配路径必须以单个 / 开头，不能包含空格、查询参数或片段。'; return
  }
  try {
    const uri = new URL(form.uri)
    if (!['http:', 'https:'].includes(uri.protocol) || uri.username || uri.password || uri.search || uri.hash || uri.port === '0') throw new Error()
  } catch { localError.value = '请输入有效的 HTTP(S) 目标地址，不包含凭据、查询参数或片段。'; return }
  if (form.rewriteEnabled && !form.rewriteRegex?.trim() && !form.path.endsWith('/**')) {
    localError.value = '此匹配路径未以 /** 结尾，请填写重写正则。'; return
  }
  emit('save', { ...form, id: form.id.trim(), path: form.path.trim(), uri: form.uri.trim() })
}
</script>
<template>
  <dialog ref="dialog" class="orbit-dialog orbit-editor" aria-labelledby="route-editor-title"
    @cancel.prevent="!saving && emit('close')" @close="!disposing && emit('close')">
    <form @submit.prevent="submit">
      <header class="orbit-dialog-head"><div><span class="orbit-eyebrow">ROUTE CONFIGURATION</span>
        <h2 id="route-editor-title">{{ route ? '编辑路由' : '新建路由' }}</h2></div>
        <button type="button" class="orbit-icon-button" :disabled="saving" aria-label="关闭编辑" @click="emit('close')"><RouteIcon name="close" /></button>
      </header>
      <div class="orbit-form-body">
        <p v-if="preview" class="orbit-form-preview">演示模式 · 修改仅保留在当前页面。</p>
        <p v-if="error || localError" class="orbit-form-error" role="alert">{{ localError || error }}</p>
        <RoutePublicationReview v-if="publication" :state="publication" :current="current??null" @read="emit('read')" @review="emit('review')" />
        <p v-if="saving" class="orbit-save-status" role="status">正在保存本次路由，字段暂时锁定。</p>
        <fieldset class="orbit-editor-fields" :disabled="saving" :aria-busy="saving" aria-label="路由参数">
          <label class="orbit-field">路由 ID <span>{{ route ? '编辑时保持不变' : '可选；已有 ID 需在所读版本上核对后发布' }}</span>
            <input v-model="form.id" name="id" :readonly="!!route" maxlength="100" placeholder="例如 order-service" class="orbit-mono" autofocus />
          </label>
          <label class="orbit-field">匹配路径 <span>Path</span>
            <input v-model="form.path" name="path" maxlength="1024" required placeholder="/api/orders/**" class="orbit-mono" />
          </label>
          <label class="orbit-field">目标地址 <span>URI</span>
            <input v-model="form.uri" name="uri" maxlength="2048" required type="url" placeholder="http://order.internal:8080" class="orbit-mono" />
          </label>
          <fieldset class="orbit-fieldset">
            <legend>路径重写 <span>Rewrite</span></legend>
            <label class="orbit-toggle-label"><input v-model="form.rewriteEnabled" type="checkbox" name="rewriteEnabled" /><span class="orbit-switch" /><span>启用路径重写</span></label>
            <div v-if="form.rewriteEnabled" class="orbit-dependent-fields">
              <label class="orbit-field">重写正则 <span>Java Regex</span><input v-model="form.rewriteRegex" name="rewriteRegex" maxlength="2048" class="orbit-mono" placeholder="留空时按 /** 匹配路径自动生成" /></label>
              <label class="orbit-field">替换目标 <span>Replacement</span><input v-model="form.rewriteReplacement" name="rewriteReplacement" maxlength="2048" required class="orbit-mono" /></label>
            </div>
          </fieldset>
          <fieldset class="orbit-fieldset">
            <legend>熔断保护 <span>Circuit Breaker</span></legend>
            <label class="orbit-toggle-label"><input v-model="form.circuitBreakerEnabled" type="checkbox" name="circuitBreakerEnabled" /><span class="orbit-switch" /><span>启用熔断保护</span></label>
            <div v-if="form.circuitBreakerEnabled" class="orbit-dependent-fields">
              <label class="orbit-field">熔断器名称<input v-model="form.circuitBreakerName" name="circuitBreakerName" maxlength="200" class="orbit-mono" placeholder="留空时生成 cb-路由ID" /></label>
              <label class="orbit-field">兼容降级路径<input v-model="form.fallbackPath" name="fallbackPath" readonly class="orbit-mono" /></label>
              <p class="orbit-field-note">熔断拒绝为 503，连接错误为 502，等待超时为 504。保护覆盖完整响应；同名熔断器共享本实例状态。降级路径保留兼容，代理故障不再内部转发。</p>
            </div>
          </fieldset>
        </fieldset>
      </div>
      <footer class="orbit-dialog-footer"><button type="button" class="orbit-button" :disabled="saving" @click="emit('close')">取消</button>
        <button type="submit" class="orbit-button orbit-primary" :disabled="saving || canSubmit===false"><RouteIcon name="check" />{{ saving ? '保存中…' : '保存路由' }}</button></footer>
    </form>
  </dialog>
</template>

<style scoped>
.orbit-editor-fields { border:0; padding:0; margin:0; min-inline-size:0; }
.orbit-editor-fields:disabled input { cursor:wait; }
.orbit-editor-fields:disabled .orbit-toggle-label { cursor:wait; }
.orbit-save-status { margin:0 0 18px; color:var(--orbit-muted); font-size:14px; line-height:1.6; }
</style>
