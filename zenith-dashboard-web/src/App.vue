<template>
  <div class="min-h-screen bg-slate-950 text-slate-100">
    <header class="border-b border-slate-800 bg-slate-900/60">
      <div class="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <h1 class="text-lg font-semibold">Zenith Dashboard</h1>
        <nav class="flex gap-4 text-sm">
          <RouterLink class="text-slate-300 hover:text-white" to="/">Dashboard</RouterLink>
          <RouterLink class="text-slate-300 hover:text-white" to="/settings">Settings</RouterLink>
        </nav>
      </div>
    </header>
    <main class="mx-auto max-w-6xl p-6">
      <RouterView />
    </main>
  </div>
</template>

