<script setup lang="ts">
import { computed } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { getBatches, getProjects, getRules } from '@/api/http'
import StatusTag from '@/components/StatusTag.vue'
import { snapshotIsStale } from '@/utils/batch'
import type { BatchItem, ReviewBatch } from '@/types'

const { data: batches, isLoading } = useQuery({ queryKey: ['batches'], queryFn: () => getBatches() })
const { data: projects } = useQuery({ queryKey: ['projects'], queryFn: getProjects })
const { data: rules } = useQuery({ queryKey: ['rules'], queryFn: getRules })

const projectName = (id: string) =>
  projects.value?.find((project) => project.id === id)?.name ?? id

const stageLabelOf = (stage: 'collecting' | 'in-review' | 'completed') =>
  ({ collecting: '分片收集期', 'in-review': '评审中', completed: '评审完成' })[stage]

interface QueueRow {
  batch: ReviewBatch
  item: BatchItem
}

const queue = computed<QueueRow[]>(() =>
  (batches.value ?? [])
    .filter((batch) => batch.stage !== 'completed' || batch.items.some((item) => item.status === 'pending'))
    .flatMap((batch) =>
      batch.items
        .filter((item) => item.status === 'pending')
        .map((item) => ({ batch, item })),
    )
    .sort((a, b) => b.item.mismatchRate - a.item.mismatchRate),
)

const activeBatches = computed(() =>
  (batches.value ?? []).filter((batch) => batch.stage !== 'completed'),
)

const highRisk = computed(() => queue.value.filter((row) => row.item.mismatchRate >= 5).length)
const archivedFragments = computed(() =>
  (batches.value ?? []).reduce(
    (sum, batch) => sum + batch.items.reduce((total, item) => total + item.archivedFragments.length, 0),
    0,
  ),
)

const unjudgedRegions = (item: BatchItem) =>
  item.regions.filter((region) => region.decision !== 'ignored' && region.decision !== 'confirmed').length

const staleBatches = computed(() =>
  (batches.value ?? []).filter((batch) => rules.value && snapshotIsStale(batch, rules.value)),
)
</script>

<template>
  <section class="page-intro compact">
    <div>
      <h2>待审批队列（按评审批次）</h2>
      <p>同页面的执行机分片已归档为同一条目；批准、驳回和区域判定全程留痕，晚到分片不会绕过已批准基线。</p>
    </div>
  </section>

  <a-alert v-if="staleBatches.length" type="warning" style="margin-bottom: 16px">
    {{ staleBatches.length }} 个批次进入评审后规则发生变化，可在批次内仅重算未批准部分，已确认区域保持固定。
  </a-alert>

  <div class="queue-summary">
    <div>
      <span>待评审条目</span>
      <strong>{{ queue.length }}</strong>
    </div>
    <div>
      <span>高风险条目</span>
      <strong class="danger">{{ highRisk }}</strong>
    </div>
    <div>
      <span>进行中批次</span>
      <strong>{{ activeBatches.length }}</strong>
    </div>
    <div>
      <span>已折叠分片</span>
      <strong>{{ archivedFragments }}</strong>
    </div>
  </div>

  <a-card class="table-panel" :bordered="false">
    <template #title>批次评审队列</template>
    <a-table :data="queue" :loading="isLoading" :pagination="{ pageSize: 10 }" row-key="item.id">
      <template #columns>
        <a-table-column title="页面 / 批次" :width="300">
          <template #cell="{ record }">
            <div class="primary-cell">
              <router-link :to="`/runs/${record.item.primaryRunId}`">
                <strong>{{ record.item.page }}</strong>
              </router-link>
              <span>
                {{ projectName(record.batch.projectId) }} ·
                <router-link :to="`/batches/${record.batch.id}`">{{ record.batch.name }}</router-link>
              </span>
            </div>
          </template>
        </a-table-column>
        <a-table-column title="风险" :width="120">
          <template #cell="{ record }">
            <a-tag :color="record.item.mismatchRate >= 5 ? 'red' : record.item.mismatchRate >= 2 ? 'orange' : 'gray'">
              {{ record.item.mismatchRate.toFixed(2) }}%
            </a-tag>
          </template>
        </a-table-column>
        <a-table-column title="待判定区域" :width="120">
          <template #cell="{ record }">{{ unjudgedRegions(record.item) }} 处</template>
        </a-table-column>
        <a-table-column title="归档分片" :width="100">
          <template #cell="{ record }">{{ record.item.archivedFragments.length }} 个</template>
        </a-table-column>
        <a-table-column title="构建" :width="180">
          <template #cell="{ record }"><code>{{ record.batch.build }}</code></template>
        </a-table-column>
        <a-table-column title="批次阶段" :width="130">
          <template #cell="{ record }">
            <a-tag :color="record.batch.stage === 'collecting' ? 'orange' : 'arcoblue'">
              {{ stageLabelOf(record.batch.stage) }}
            </a-tag>
          </template>
        </a-table-column>
        <a-table-column title="状态" :width="100">
          <template #cell="{ record }"><StatusTag :status="record.item.status" /></template>
        </a-table-column>
        <a-table-column title="操作" :width="120" fixed="right">
          <template #cell="{ record }">
            <router-link :to="`/runs/${record.item.primaryRunId}`">
              {{ record.batch.stage === 'collecting' ? '先进入评审' : '开始评审' }}
            </router-link>
          </template>
        </a-table-column>
      </template>
    </a-table>
  </a-card>
</template>
