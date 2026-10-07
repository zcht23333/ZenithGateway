<script setup lang="ts">
import { computed } from 'vue'
import type { RouteRule, RuntimeConfig } from '../stores/traffic'
import RouteIcon from './RouteIcon.vue'
const props = defineProps<{ route: RouteRule; config: RuntimeConfig | null; stale: boolean }>()
const steps = computed(() => [
  { kind: 'entry', label: '匹配入口', value: props.route.path, note: '' },
  { kind: 'limit', label: '全局限流', value: !props.config ? '配置未获取' :
      props.config.rateLimitEnabled ? props.config.replenishRate.toLocaleString() + ' 令牌/s · 每个 IP' : '已关闭 · 直接通过',
    note: props.config?.rateLimitEnabled ? '令牌桶容量 ' + props.config.burstCapacity.toLocaleString() +
      ' · 每次消耗 ' + props.config.requestedTokens : '' },
  ...(props.route.circuitBreakerEnabled ? [{ kind: 'breaker', label: '熔断保护',
    value: props.route.circuitBreakerName, note: '' }] : []),
  ...(props.route.rewriteEnabled ? [{ kind: 'rewrite', label: '路径重写',
    value: props.route.rewriteRegex, note: '' }] : []),
  { kind: 'target', label: '目标服务', value: props.route.uri, note: '' }
])
</script>
<template>
  <section class="route-flow" aria-labelledby="selected-route-title">
    <div class="route-flow-head">
      <div><span class="orbit-eyebrow">SELECTED ROUTE</span><h2 id="selected-route-title">当前路由</h2></div>
      <RouteIcon name="target" :size="28" />
    </div>
    <div class="route-flow-identity">
      <span class="orbit-status" :class="stale ? 'is-warning' : 'is-focus'"><i />{{ stale ? '缓存配置' : '已选中' }}</span>
      <h3>{{ route.id }}</h3>
      <p>按当前配置展开请求处理顺序</p>
    </div>
    <ol class="route-flow-steps" :key="route.id">
      <li v-for="(step, index) in steps" :key="step.kind" :class="['flow-step', 'flow-' + step.kind]">
        <span class="flow-node" aria-hidden="true">{{ String(index + 1).padStart(2, '0') }}</span>
        <div class="flow-step-body">
          <h4>{{ step.label }}<span v-if="step.kind === 'limit'" class="flow-global">全局</span></h4>
          <code v-if="step.kind !== 'limit'">{{ step.value }}</code>
          <p v-else class="flow-limit-value">{{ step.value }}</p>
          <div v-if="step.kind === 'rewrite'" class="flow-replacement">
            <RouteIcon name="arrow" :size="16" /><code>{{ route.rewriteReplacement }}</code>
          </div>
          <p v-if="step.kind === 'limit' && config?.rateLimitEnabled" class="flow-reject">超额请求 → HTTP 429</p>
          <p v-if="step.note" class="flow-note">{{ step.note }}</p>
          <div v-if="step.kind === 'breaker'" class="flow-fallback">
            <div><span class="flow-branch-symbol" aria-hidden="true">↳</span><span>熔断拒绝</span><span class="flow-http">HTTP 503</span></div>
            <code>连接错误 502 · 超时 504</code>
            <p>业务状态与响应体原样返回。响应已开始后发生故障，只终止响应，不追加错误内容。</p>
          </div>
        </div>
      </li>
    </ol>
    <p v-if="!route.rewriteEnabled || !route.circuitBreakerEnabled" class="flow-omitted">
      未启用：{{ [!route.rewriteEnabled && '路径重写', !route.circuitBreakerEnabled && '熔断保护'].filter(Boolean).join('、') }}
    </p>
    <div class="flow-completion"><RouteIcon name="activity" /><div><strong>响应完成后</strong><p>监控统计 · 异步审计（启用时）</p></div></div>
  </section>
</template>
