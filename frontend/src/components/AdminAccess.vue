<script setup lang="ts">
import { ref } from 'vue'
import { authenticate, authState } from '../api'
defineProps<{notice?:string}>()
const token = ref('')
async function connect() { const value = token.value; token.value = ''; await authenticate(value) }
</script>
<template>
  <section class="zenith-access">
    <h1>连接管理控制台</h1>
    <p>请输入管理凭据。凭据仅在当前页面有效，刷新后需重新输入。</p>
    <p v-if="notice" class="zenith-access-notice" role="status">{{ notice }}</p>
    <form @submit.prevent="connect">
      <label for="admin-token">管理凭据</label>
      <input id="admin-token" v-model="token" type="password" autocomplete="off" />
      <p v-if="authState.error" role="alert">{{ authState.error }}</p>
      <button :disabled="authState.checking" type="submit" class="zenith-button is-primary">{{ authState.checking ? '连接中…' : '连接' }}</button>
    </form>
  </section>
</template>
