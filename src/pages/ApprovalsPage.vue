<script setup lang="ts">
import { computed } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { getBatches, getRuns } from '@/api/http'
import type { BatchStatus, RunStatus } from '@/types'

// 批次与旧运行并存：已归档批次按批次聚合展示，尚未打开过的旧运行仍按单运行展示
const { data: batches, isLoading: batchesLoading } = useQuery({
  queryKey: ['batches', 'queue'],
  queryFn: () => getBatches(),
})
const { data: runs, isLoading: runsLoading } = useQuery({
  queryKey: ['runs', 'queue-legacy'],
  queryFn: () => getRuns(),
})

interface QueueRow {
  key: string
  page: string
  name: string
  build: string
  projectId: string
  runId: string
  shardCount: number
  pendingCount: number
  round: number
  status: RunStatus | BatchStatus
  mismatch: number
  capturedAt: string
}

const rows = computed<QueueRow[]>(() => {
  const batchRows: QueueRow[] = (batches.value ?? []).map((batch) => ({
    key: batch.id,
    page: batch.page,
    name: `批次 ${batch.id.slice(-6)}`,
    build: batch.build,
    projectId: batch.projectId,
    runId: batch.runIds[0],
    shardCount: batch.runCount,
    pendingCount: batch.pendingCount,
    round: batch.currentRound,
    status: batch.status,
    mismatch: batch.maxMismatch,
    capturedAt: batch.updatedAt,
  }))
  const batchedRunIds = new Set((batches.value ?? []).flatMap((batch) => batch.runIds))
  const legacyRows: QueueRow[] = (runs.value ?? [])
    .filter((run) => !run.duplicated && !run.batchId && !batchedRunIds.has(run.id))
    .map((run) => ({
      key: run.id,
      page: run.page,
      name: run.name,
      build: run.build,
      projectId: run.projectId,
      runId: run.id,
      shardCount: 1,
      pendingCount: run.status === 'pending' ? 1 : 0,
      round: 0,
      status: run.status,
      mismatch: run.mismatchRate,
      capturedAt: run.capturedAt,
    }))
  return [...batchRows, ...legacyRows].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))
})

const actionableRows = computed(() => rows.value.filter((row) => row.pendingCount > 0))
const highRiskCount = computed(() => actionableRows.value.filter((row) => row.mismatch >= 5).length)
const isLoading = computed(() => batchesLoading.value || runsLoading.value)

const statusColor = (status: QueueRow['status']) =>
  ({
    pending: 'orange',
    collecting: 'grayblue',
    'in-review': 'arcoblue',
    'partially-approved': 'purple',
    approved: 'green',
    rejected: 'red',
    merged: 'cyan',
  })[status] ?? 'gray'

const statusLabel = (status: QueueRow['status']) =>
  ({
    pending: '待审批',
    collecting: '收片中',
    'in-review': '评审中',
    'partially-approved': '部分批准·续算',
    approved: '已批准',
    rejected: '已驳回',
    merged: '已合并',
  })[status] ?? status
</script>

<template>
  <section class="page-intro compact">
    <div>
      <h2>待审批队列</h2>
      <p>同项目同构建的回传分片自动归入同一评审批次；批准只新增基线版本，历史依据完整保留。</p>
    </div>
  </section>

  <div class="queue-summary">
    <div>
      <span>待处理批次 / 运行</span>
      <strong>{{ actionableRows.length }}</strong>
    </div>
    <div>
      <span>高风险批次</span>
      <strong class="danger">{{ highRiskCount }}</strong>
    </div>
    <div>
      <span>含多分片批次</span>
      <strong>{{ rows.filter((row) => row.shardCount > 1).length }}</strong>
    </div>
    <div>
      <span>续算批次</span>
      <strong>{{ rows.filter((row) => row.round > 1).length }}</strong>
    </div>
  </div>

  <a-card class="table-panel" :bordered="false">
    <a-table :data="rows" :loading="isLoading" :pagination="false" row-key="key">
      <template #columns>
        <a-table-column title="评审对象" :width="260">
          <template #cell="{ record }">
            <div class="primary-cell">
              <router-link :to="`/runs/${record.runId}`">{{ record.page }}</router-link>
              <span>{{ record.name }} · {{ record.runId }}</span>
            </div>
          </template>
        </a-table-column>
        <a-table-column title="风险" :width="110">
          <template #cell="{ record }">
            <a-tag :color="record.mismatch >= 5 ? 'red' : record.mismatch >= 2 ? 'orange' : 'gray'">
              {{ record.mismatch.toFixed(2) }}%
            </a-tag>
          </template>
        </a-table-column>
        <a-table-column title="分片 / 待评审" :width="150">
          <template #cell="{ record }">
            <strong>{{ record.shardCount }}</strong> 个分片 ·
            <a-tag :color="record.pendingCount > 0 ? 'orange' : 'green'" size="small">
              {{ record.pendingCount }} 待评
            </a-tag>
          </template>
        </a-table-column>
        <a-table-column title="评审轮次" :width="120">
          <template #cell="{ record }">
            <a-tag v-if="record.round > 0" color="purple" size="small">R{{ record.round }}</a-tag>
            <span v-else class="sub-text">未进入评审</span>
          </template>
        </a-table-column>
        <a-table-column title="构建" data-index="build" :width="180" />
        <a-table-column title="更新时间" :width="150">
          <template #cell="{ record }">{{ record.capturedAt.slice(5, 16).replace('T', ' ') }}</template>
        </a-table-column>
        <a-table-column title="状态" :width="130">
          <template #cell="{ record }">
            <a-tag :color="statusColor(record.status)">{{ statusLabel(record.status) }}</a-tag>
          </template>
        </a-table-column>
        <a-table-column title="操作" :width="100" fixed="right">
          <template #cell="{ record }"><router-link :to="`/runs/${record.runId}`">开始评审</router-link></template>
        </a-table-column>
      </template>
    </a-table>
  </a-card>
</template>
