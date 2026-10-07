<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AdminAccess from './components/AdminAccess.vue'
import ZenithHeader from './components/ZenithHeader.vue'
import { authenticate, authState } from './api'
import { useSettingsStore } from './settings/editor'
import { confirmSettingsLeave } from './settings/leave'
import { useRouteEditorStore, confirmRouteLeave } from './routes/editor'
import './styles/product.css'
const route = useRoute(), router = useRouter()
// Only these explicit, isolated preview components can render without management authentication.
const isPreview = computed(() => route.name === 'routes-preview' || route.name === 'overview-preview' || route.name === 'settings-preview')
const allowed = computed(() => isPreview.value || authState.authenticated)
const shellHeader = computed(() => !allowed.value)
const settings = useSettingsStore()
const routeEditor = useRouteEditorStore()
const removeGuard = router.beforeEach((to,from) => from.name === 'settings' && to.name !== 'settings' ? confirmSettingsLeave(settings) : from.path === '/routes' && to.path !== '/routes' ? confirmRouteLeave(routeEditor) : true)
function beforeUnload(event: BeforeUnloadEvent) {
  if (settings.protectedDraft || routeEditor.protectedDraft) { event.preventDefault(); event.returnValue = '' }
}
watch(() => authState.authenticated, (authenticated,previous) => {
  if(previous && !authenticated) routeEditor.authenticationExpired()
  if (previous && !authenticated && settings.protectedDraft) { settings.state.authExpired = true; settings.state.needsConfirmation = true }
},{flush:'sync'})
onMounted(async () => {
  window.addEventListener('beforeunload',beforeUnload)
  await router.isReady()
  if (!isPreview.value && !authState.ready) void authenticate('')
})
watch(isPreview,value => { if (!value && !authState.ready) void authenticate('') })
onBeforeUnmount(() => { removeGuard(); window.removeEventListener('beforeunload',beforeUnload) })
</script>
<template>
  <div class="zenith-app antialiased">
    <ZenithHeader v-if="shellHeader" />
    <main v-if="!isPreview && !authState.ready" class="zenith-access-shell" role="status">正在连接管理控制台…</main>
    <div v-else-if="allowed"><RouterView :key="route.name || route.path" /></div>
    <main v-else class="zenith-access-shell"><AdminAccess :notice="routeEditor.protectedDraft ? '路由草稿及核对基准已保留。重新认证后请读取当前状态并核对，不会自动发布。' : settings.protectedDraft ? '配置草稿或待确认的保存结果已暂存在当前页面内存中。重新连接后会先读取核对；刷新页面会丢失这些内容。' : ''" /></main>
  </div>
</template>
