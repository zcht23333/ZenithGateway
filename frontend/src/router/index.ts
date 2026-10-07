import { createRouter, createWebHistory } from 'vue-router'
import AsyncPage from '../components/AsyncPage.vue'

export default createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: AsyncPage, props: {page:'overview'} },
    { path: '/overview/preview', name: 'overview-preview', component: AsyncPage, props: {page:'overview',preview:true} },
    { path: '/settings', name: 'settings', component: AsyncPage, props: {page:'settings'} },
    { path: '/settings/preview', name: 'settings-preview', component: AsyncPage, props: {page:'settings',preview:true} },
    { path: '/routes', component: AsyncPage, props: {page:'routes'} },
    { path: '/routes/preview', name: 'routes-preview', component: AsyncPage, props: {page:'routes',preview:true} }
  ]
})
