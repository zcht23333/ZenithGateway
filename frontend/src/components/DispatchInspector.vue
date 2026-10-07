<script setup lang="ts">
import { computed } from 'vue'
import type { RouteRule, RuntimeConfig } from '../stores/traffic'
import { matchingExample, rewriteExample, type StationKind } from '../routes/routeIllustration'
import RouteIcon from './RouteIcon.vue'
import DispatchCopy from './DispatchCopy.vue'
const props = defineProps<{ kind: StationKind; route: RouteRule; config: RuntimeConfig | null }>()
defineEmits<{ close: [] }>()
const titles: Record<StationKind, string> = { entry:'入口匹配', limit:'全局限流', rewrite:'路径重写', breaker:'熔断保护', target:'目标服务' }
const match = computed(() => matchingExample(props.route))
const example = computed(() => rewriteExample(props.route))
const fields = computed(() => props.kind === 'entry' ? [{ label:'Path 匹配条件', value:props.route.path }] :
  props.kind === 'rewrite' ? [{ label:'匹配正则 · Java', value:props.route.rewriteRegex ?? '' }, { label:'替换目标', value:props.route.rewriteReplacement ?? '' }] :
  props.kind === 'breaker' ? [{ label:'熔断器名称', value:props.route.circuitBreakerName }, { label:'兼容降级路径', value:props.route.fallbackPath }] :
  props.kind === 'target' ? [{ label:'完整目标 URI', value:props.route.uri }] : [])
</script>
<template>
  <div class="dispatch-inspector-content">
    <header><div><span class="dispatch-inspector-kicker">节点规则</span><h3>{{ titles[kind] }}</h3></div><button class="dispatch-icon-button" aria-label="关闭节点详情" @click="$emit('close')"><RouteIcon name="close" :size="19" /></button></header>
    <div class="dispatch-inspector-body">
      <template v-if="kind === 'rewrite' && example">
        <div class="dispatch-example-label">改写示例 <span>按规则推导</span></div>
        <div class="dispatch-example"><code>{{ example.before }}</code><RouteIcon name="arrow" :size="19" /><code>{{ example.after }}</code></div>
      </template>
      <div v-for="field in fields" :key="field.label" class="dispatch-value">
        <span>{{ field.label }}</span><div><code>{{ field.value || '未设置' }}</code><DispatchCopy :value="field.value" :label="field.label" /></div>
      </div>
      <template v-if="kind === 'entry'">
        <div v-if="match" class="dispatch-value"><span>可匹配路径示例</span><div><code>{{ match }}</code><DispatchCopy :value="match" label="匹配示例" /></div></div>
        <p class="dispatch-inspector-note">{{ match ? '这是当前 Path 条件的匹配示例。' : '此 Path 模式的匹配结果需在真实网关验证。' }}</p>
      </template>
      <template v-if="kind === 'limit'">
        <p v-if="!config" class="dispatch-inspector-note">限流配置未获取，暂不推断是否放行。</p>
        <p v-else-if="!config.rateLimitEnabled" class="dispatch-inspector-note">全局限流已关闭，请求直接进入下一阶段。</p>
        <template v-else>
          <div class="dispatch-limit-facts"><div><span>补充速率</span><strong>{{ config.replenishRate.toLocaleString() }}<small>令牌/s</small></strong></div><div><span>桶容量</span><strong>{{ config.burstCapacity.toLocaleString() }}</strong></div><div><span>每次消耗</span><strong>{{ config.requestedTokens }}</strong></div></div>
          <p class="dispatch-inspector-note">每个 IP 独立计数。令牌充足时继续处理；令牌不足时返回 HTTP 429。</p>
          <p class="dispatch-inspector-note">Redis 超时或故障时，当前实现降级放行。</p>
        </template>
      </template>
      <p v-if="kind === 'rewrite' && !example" class="dispatch-inspector-note">此正则的改写示例需在真实网关验证。</p>
      <template v-if="kind === 'breaker'">
        <p class="dispatch-conditional-note">熔断拒绝返回 503；连接错误返回 502；等待超时返回 504。上游业务响应原样保留；已开始的响应只终止，不追加错误内容。所有 HTTP 代理均受启动超时策略保护，不自动重试。</p>
        <p class="dispatch-inspector-note">上游直接返回的普通 HTTP 500 按原响应传递。</p>
      </template>
      <template v-if="kind === 'target'">
        <div v-if="example" class="dispatch-value"><span>{{ route.rewriteEnabled ? '请求路径示例 · 重写后' : '请求路径示例 · 保持原路径' }}</span><div><code>{{ example.after }}</code><DispatchCopy :value="example.after" label="转发路径示例" /></div></div>
        <p class="dispatch-inspector-note">向配置的 HTTP(S) 上游转发请求。</p>
      </template>
    </div>
  </div>
</template>
