<template>
  <div ref="chartEl" class="h-72 w-full"></div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as echarts from 'echarts'
import type { TrafficMetricsSnapshot } from '../stores/traffic'

const props = defineProps<{
  points: TrafficMetricsSnapshot[]
}>()

const chartEl = ref<HTMLDivElement | null>(null)
let chart: echarts.ECharts | null = null

function render() {
  if (!chart) {
    return
  }

  const labels = props.points.map((item) => new Date(item.timestamp).toLocaleTimeString())
  const qps = props.points.map((item) => Number(item.qps.toFixed(2)))
  const p95 = props.points.map((item) => item.p95LatencyMs)

  chart.setOption({
    tooltip: { trigger: 'axis' },
    legend: { textStyle: { color: '#cbd5e1' } },
    xAxis: {
      type: 'category',
      data: labels,
      axisLabel: { color: '#94a3b8' }
    },
    yAxis: [
      { type: 'value', name: 'QPS', axisLabel: { color: '#94a3b8' } },
      { type: 'value', name: 'P95(ms)', axisLabel: { color: '#94a3b8' } }
    ],
    series: [
      { name: 'QPS', type: 'line', data: qps, smooth: true },
      { name: 'P95', type: 'line', yAxisIndex: 1, data: p95, smooth: true }
    ],
    grid: { left: 40, right: 40, top: 40, bottom: 40 },
    backgroundColor: 'transparent'
  })
}

onMounted(() => {
  if (chartEl.value) {
    chart = echarts.init(chartEl.value)
    render()
  }
})

watch(
  () => props.points,
  () => render(),
  { deep: true }
)

onBeforeUnmount(() => {
  chart?.dispose()
  chart = null
})
</script>

