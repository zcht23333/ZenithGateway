<script setup lang="ts">
withDefaults(defineProps<{ name: string; size?: number }>(), { size: 20 })
const paths: Record<string, string> = {
  copy: 'M9 8h11v13H9V8ZM15 8V3H4v13h5',
  shield: 'M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6l-9-4Z',
  server: 'M4 3h16v7H4V3Zm0 11h16v7H4v-7ZM7 6h1m-1 11h1',
  sliders: 'M3 5h8m4 0h6M3 12h3m4 0h11M3 19h12m4 0h2M11 3v4M6 10v4m9 3v4',
  chevron: 'm6 9 6 6 6-6',
  plus: 'M12 5v14M5 12h14',
  search: 'M21 21l-4.4-4.4M19 10.5a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0Z',
  arrow: 'M4 12h16m-6-6 6 6-6 6',
  refresh: 'M20 7v5h-5M4 17v-5h5M19 12a7 7 0 0 0-12-5L4 10m1 2a7 7 0 0 0 12 5l3-3',
  close: 'm6 6 12 12M6 18 18 6',
  check: 'm5 12 4 4L19 6',
  alert: 'M12 3 2 21h20L12 3Zm0 6v5m0 3v1',
  edit: 'm15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15v5Z',
  trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7',
  left: 'm14 6-6 6 6 6',
  right: 'm10 6 6 6-6 6',
  exit: 'M9 4H4v16h5m5-4 4-4-4-4M8 12h11',
  activity: 'M2 12h4l3-8 6 16 3-8h4',
  filter: 'M4 6h16M7 12h10m-7 6h4',
  target: 'M12 2v4m0 12v4M2 12h4m12 0h4M19 12a7 7 0 1 1-14 0 7 7 0 0 1 14 0Zm-4 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  info: 'M12 11v6m0-10v1m9 4a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z'
}
</script>
<template><svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path :d="paths[name] || paths.info" />
</svg></template>
