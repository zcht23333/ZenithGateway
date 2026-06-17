<template>
  <div ref="chartEl" class="h-72 w-full"></div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch, toRaw } from 'vue'
// 1. 按需引入 ECharts 核心和所需组件，极大减少 JS bundle 体积
import * as echarts from 'echarts/core'
import { LineChart } from 'echarts/charts'
import { TooltipComponent, GridComponent, LegendComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

import type { TrafficMetricsSnapshot } from '../stores/traffic'

// 注册所需组件
echarts.use([LineChart, TooltipComponent, GridComponent, LegendComponent, CanvasRenderer])

const props = defineProps<{
  points: TrafficMetricsSnapshot[]
}>()

const chartEl = ref<HTMLDivElement | null>(null)
let chart: echarts.ECharts | null = null
let resizeObserver: ResizeObserver | null = null

function render() {
  if (!chart) return

  // 2. 解除 Vue 的 Proxy 响应式代理，防止 ECharts 内部处理时触发无用的 get 拦截，大幅提升性能
  const rawPoints = toRaw(props.points)

  const labels = rawPoints.map((item) => new Date(item.timestamp).toLocaleTimeString())
  const qps = rawPoints.map((item) => Number(item.qps.toFixed(2)))
  const p95 = rawPoints.map((item) => item.p95LatencyMs)

  chart.setOption({
    // 3. 视觉优化：匹配 SSE 的 1 秒刷新率，实现流水线般的平滑滚动效果
    animationDurationUpdate: 1000, 
    animationEasingUpdate: 'linear',
    
    tooltip: { trigger: 'axis' },
    legend: { textStyle: { color: '#cbd5e1' } },
    xAxis: {
      type: 'category',
      data: labels,
      axisLabel: { color: '#94a3b8' }
    },
    yAxis: [
      { type: 'value', name: 'QPS', axisLabel: { color: '#94a3b8' }, splitLine: { lineStyle: { color: '#334155' } } },
      { type: 'value', name: 'P95(ms)', axisLabel: { color: '#94a3b8' }, splitLine: { show: false } }
    ],
    series: [
      { 
        name: 'QPS', 
        type: 'line', 
        data: qps, 
        smooth: true, 
        showSymbol: false, // 隐藏数据点的小圆圈，只在 hover 时显示，提升大量数据时的渲染性能
        lineStyle: { width: 3, color: '#3b82f6' } 
      },
      { 
        name: 'P95', 
        type: 'line', 
        yAxisIndex: 1, 
        data: p95, 
        smooth: true, 
        showSymbol: false,
        lineStyle: { width: 3, color: '#10b981' } 
      }
    ],
    grid: { left: 40, right: 40, top: 40, bottom: 40 },
    backgroundColor: 'transparent'
  })
}

onMounted(() => {
  if (chartEl.value) {
    chart = echarts.init(chartEl.value)
    render()

    // 4. 使用 ResizeObserver 监听容器大小变化，实现图表自适应
    resizeObserver = new ResizeObserver(() => {
      chart?.resize()
    })
    resizeObserver.observe(chartEl.value)
  }
})

watch(
  () => props.points,
  () => render(),
  { deep: true }
)

onBeforeUnmount(() => {
  // 组件卸载时清理监听器和图表实例，防止内存泄漏
  if (resizeObserver && chartEl.value) {
    resizeObserver.unobserve(chartEl.value)
    resizeObserver.disconnect()
  }
  chart?.dispose()
  chart = null
})
</script>