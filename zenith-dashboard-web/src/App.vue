<template>
  <div class="min-h-screen bg-[#070a13] text-slate-200 antialiased selection:bg-indigo-500/20">
    <header class="sticky top-0 z-50 border-b border-slate-900 bg-[#070a13]/70 backdrop-blur-md">
      <div class="mx-auto flex max-w-5xl items-center justify-between px-6 py-3.5">
        <div class="flex items-center gap-2.5">
          <div class="h-2 w-2 rounded-full bg-indigo-500 shadow-[0_0_10px_rgba(99,102,241,0.5)]"></div>
          <span class="text-sm font-semibold tracking-wider text-slate-100">ZENITH</span>
          <span class="text-[10px] font-mono uppercase tracking-widest text-slate-500">API 网关</span>
        </div>
        
        <nav class="flex gap-1 text-xs font-medium">
          <RouterLink class="rounded-md px-3 py-1.5 text-slate-400 transition-all hover:text-slate-100" active-class="bg-slate-900/60 !text-slate-100 font-semibold" to="/">总览</RouterLink>
          <RouterLink class="rounded-md px-3 py-1.5 text-slate-400 transition-all hover:text-slate-100" active-class="bg-slate-900/60 !text-slate-100 font-semibold" to="/routes">路由配置</RouterLink>
          <RouterLink class="rounded-md px-3 py-1.5 text-slate-400 transition-all hover:text-slate-100" active-class="bg-slate-900/60 !text-slate-100 font-semibold" to="/settings">系统设置</RouterLink>
        </nav>
      </div>
    </header>
    
    <main class="mx-auto max-w-5xl px-6 py-10 transition-all duration-300">
      <RouterView />
    </main>
  </div>
</template>