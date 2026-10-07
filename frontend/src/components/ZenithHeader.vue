<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { authState, logout } from '../api'
import { useTrafficStore } from '../stores/traffic'
import RouteIcon from './RouteIcon.vue'
const props = withDefaults(defineProps<{ preview?: boolean; beforeDisconnect?: () => boolean }>(), {preview:false})
const route = useRoute(), menu = ref(false)
const routePage = computed(() => route.path.startsWith('/routes'))
const links = computed(() => [
  {name:'运行概览',to:props.preview ? '/overview/preview' : '/',active:route.path === '/' || route.name === 'overview-preview'},
  {name:'路由调度',to:props.preview ? '/routes/preview' : '/routes',active:routePage.value},
  {name:'系统配置',to:props.preview ? '/settings/preview' : '/settings',active:route.name === 'settings' || route.name === 'settings-preview'}
])
watch(() => route.fullPath, () => { menu.value = false })
function disconnect() { if (props.beforeDisconnect && !props.beforeDisconnect()) return; useTrafficStore().disconnectSse(); logout() }
function closeMenu() { menu.value = false; document.getElementById('zenith-menu-toggle')?.focus() }
</script>
<template>
  <header class="zenith-header" :class="{ 'dispatch-topbar':routePage }" @keydown.esc.stop="closeMenu">
    <RouterLink class="zenith-brand" :to="preview ? '/overview/preview' : '/'" aria-label="ZenithGateway">
      <svg viewBox="0 0 38 38" width="38" height="38" fill="none" aria-hidden="true"><circle cx="19" cy="19" r="10" stroke="currentColor" stroke-width="1.5"/><ellipse cx="19" cy="19" rx="18" ry="7" transform="rotate(-35 19 19)" stroke="currentColor" stroke-width="1.5"/><circle cx="32" cy="9" r="3" fill="currentColor"/></svg><span>ZENITH<small>GATEWAY</small></span>
    </RouterLink>
    <template v-if="authState.authenticated || preview">
      <button id="zenith-menu-toggle" class="zenith-menu-toggle" :aria-expanded="menu" aria-controls="zenith-navigation" @click.stop="menu = !menu">导航 <RouteIcon name="chevron" :size="15" /></button>
      <nav id="zenith-navigation" class="zenith-nav dispatch-nav" :class="{ 'is-open':menu }" aria-label="主导航">
        <RouterLink v-for="link in links" :key="link.name" :to="link.to" :class="{ 'is-active':link.active }" :aria-current="link.active ? 'page' : undefined">{{ link.name }}</RouterLink>
      </nav>
    </template>
    <slot />
    <button v-if="!preview && authState.authenticated" class="zenith-icon-button zenith-disconnect" :class="{ 'dispatch-disconnect':routePage }" aria-label="断开管理连接" title="断开管理连接" @click="disconnect"><RouteIcon name="exit" :size="19" /></button>
  </header>
</template>
