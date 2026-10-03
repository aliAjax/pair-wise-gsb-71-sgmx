import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { VueQueryPlugin } from '@tanstack/vue-query'
import ArcoVue from '@arco-design/web-vue'
import ArcoVueIcon from '@arco-design/web-vue/es/icon'
import '@arco-design/web-vue/dist/arco.css'
import './styles.css'
import App from './App.vue'
import router from './router'
import { initDb } from './mocks/db'

// 先完成 localStorage / IndexedDB 的恢复与旧数据迁移，再启动界面
void initDb().then(() => {
  createApp(App)
    .use(createPinia())
    .use(router)
    .use(VueQueryPlugin, {
      queryClientConfig: {
        defaultOptions: {
          queries: { staleTime: 15_000, refetchOnWindowFocus: false },
        },
      },
    })
    .use(ArcoVue)
    .use(ArcoVueIcon)
    .mount('#app')
})
