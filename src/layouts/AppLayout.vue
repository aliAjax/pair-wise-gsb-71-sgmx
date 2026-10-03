<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { Message } from '@arco-design/web-vue'
import { getSystemState, setFault } from '@/api/http'

const route = useRoute()
const router = useRouter()
const queryClient = useQueryClient()
const recoveryDismissed = ref(false)

const menuItems = [
  { key: '/', label: '运行概览', icon: 'icon-dashboard' },
  { key: '/runs', label: '回归运行', icon: 'icon-apps' },
  { key: '/approvals', label: '审批队列', icon: 'icon-check-circle' },
  { key: '/baselines', label: '历史基线', icon: 'icon-history' },
  { key: '/rules', label: '忽略规则', icon: 'icon-filter' },
  { key: '/reports', label: '结果与导出', icon: 'icon-download' },
]

const activeKey = computed(() => {
  if (route.path.startsWith('/runs')) return '/runs'
  return route.path
})

const pageTitle = computed(() => {
  const map: Record<string, string> = {
    '/': '运行概览',
    '/runs': '视觉回归运行',
    '/approvals': '审批队列',
    '/baselines': '历史基线',
    '/rules': '忽略规则',
    '/reports': '结果与导出',
  }
  return route.name === 'run-detail' ? '差异定位评审' : map[route.path] ?? '视觉基线评审台'
})

const navigate = (key: string) => {
  void router.push(key)
}

const { data: systemState, isFetching } = useQuery({
  queryKey: ['system-state'],
  queryFn: getSystemState,
  staleTime: 0,
})

const showRecovery = computed(() => Boolean(systemState.value?.recovery) && !recoveryDismissed.value)

const toggleFault = async (value: string | number | boolean) => {
  const enabled = Boolean(value)
  await setFault(enabled)
  await queryClient.invalidateQueries({ queryKey: ['system-state'] })
  Message[enabled ? 'warning' : 'success'](
    enabled
      ? '已模拟本地存储写入故障，审批保存将失败并进入预写日志，刷新页面后自动恢复'
      : '本地存储已恢复正常',
  )
}
</script>

<template>
  <a-layout class="app-shell">
    <a-layout-sider class="app-sider" :width="228" collapsible breakpoint="lg">
      <div class="brand">
        <div class="brand-mark">VR</div>
        <div>
          <strong>视觉基线评审台</strong>
          <span>Visual Review Console</span>
        </div>
      </div>
      <a-menu class="app-menu" :selected-keys="[activeKey]" @menu-item-click="navigate">
        <a-menu-item v-for="item in menuItems" :key="item.key">
          <template #icon><component :is="item.icon" /></template>
          {{ item.label }}
        </a-menu-item>
      </a-menu>
      <div class="sider-foot">
        <span class="online-dot" :class="{ fault: systemState?.fault }" />
        <div>
          <strong>{{ systemState?.fault ? '存储故障模拟中' : '对照服务正常' }}</strong>
          <small>最近同步 09:42</small>
        </div>
      </div>
    </a-layout-sider>

    <a-layout>
      <a-layout-header class="app-header">
        <div>
          <a-breadcrumb>
            <a-breadcrumb-item>质量工程</a-breadcrumb-item>
            <a-breadcrumb-item>{{ pageTitle }}</a-breadcrumb-item>
          </a-breadcrumb>
          <h1>{{ pageTitle }}</h1>
        </div>
        <a-space :size="12">
          <a-tooltip content="开启后审批保存会失败并写预写日志，刷新页面即可看到自动恢复（不产生重复审批/区域）">
            <a-space :size="6">
              <span class="fault-switch-label">存储故障模拟</span>
              <a-switch
                :model-value="systemState?.fault ?? false"
                size="small"
                :loading="isFetching"
                @change="toggleFault"
              />
            </a-space>
          </a-tooltip>
          <a-tag color="arcoblue">桌面端 1440</a-tag>
          <a-avatar :size="32" style="background: #165dff">林</a-avatar>
          <div class="reviewer">
            <strong>林默</strong>
            <span>视觉评审人</span>
          </div>
        </a-space>
      </a-layout-header>
      <a-layout-content class="app-content">
        <a-alert
          v-if="showRecovery"
          type="success"
          closable
          style="margin-bottom: 16px"
          @close="recoveryDismissed = true"
        >
          <template #title>检测到上次本地存储写入失败，已通过预写日志恢复</template>
          操作 {{ systemState?.recovery?.type }}（{{ systemState?.recovery?.opId.slice(0, 18) }}…）已于
          {{ systemState?.recovery?.recoveredAt.slice(11, 19) }} 重放，区域与审批记录无重复。
        </a-alert>
        <router-view />
      </a-layout-content>
    </a-layout>
  </a-layout>
</template>
