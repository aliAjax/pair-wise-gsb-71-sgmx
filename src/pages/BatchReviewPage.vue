<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { Message, Modal } from '@arco-design/web-vue'
import StatusTag from '@/components/StatusTag.vue'
import {
  discardDraft,
  getBatches,
  getBatch,
  getDrafts,
  getProjects,
  getRules,
  recomputeBatch,
  startReview,
  toApiError,
} from '@/api/http'
import { snapshotIsStale } from '@/utils/batch'

const route = useRoute()
const router = useRouter()
const queryClient = useQueryClient()
const batchId = computed(() => String(route.params.id))

const { data: batch, isLoading } = useQuery({
  queryKey: computed(() => ['batch', batchId.value]),
  queryFn: () => getBatch(batchId.value),
})
const { data: batches } = useQuery({ queryKey: ['batches'], queryFn: () => getBatches() })
const { data: projects } = useQuery({ queryKey: ['projects'], queryFn: getProjects })
const { data: rules } = useQuery({ queryKey: ['rules'], queryFn: getRules })
const { data: drafts } = useQuery({ queryKey: ['drafts'], queryFn: getDrafts })

const projectName = (id: string) =>
  projects.value?.find((project) => project.id === id)?.name ?? id

const stale = computed(() =>
  batch.value && rules.value ? snapshotIsStale(batch.value, rules.value) : false,
)

const batchDrafts = computed(() =>
  (drafts.value ?? []).filter((draft) => draft.batchId === batchId.value),
)

const stats = computed(() => {
  const items = batch.value?.items ?? []
  const pending = items.filter((item) => item.status === 'pending').length
  const approved = items.filter((item) => item.status === 'approved').length
  const rejected = items.filter((item) => item.status === 'rejected').length
  const fragments = items.reduce((sum, item) => sum + item.archivedFragments.length, 0)
  return { pending, approved, rejected, fragments }
})

const stageLabel = computed(() => {
  if (!batch.value) return ''
  const labels: Record<string, string> = {
    collecting: '分片收集期',
    'in-review': '评审中',
    completed: '评审完成',
  }
  return labels[batch.value.stage]
})

const stageLabelOf = (stage: 'collecting' | 'in-review' | 'completed') =>
  ({ collecting: '分片收集期', 'in-review': '评审中', completed: '评审完成' })[stage]

const startMutation = useMutation({
  mutationFn: () => startReview(batchId.value),
  onSuccess: async (result) => {
    Message.success(
      result.started ? '规则快照与区域判定已固定，可以开始评审' : '批次已在评审中',
    )
    await refresh()
  },
  onError: (error: unknown) => Message.error(toApiError(error).message),
})

const recomputeMutation = useMutation({
  mutationFn: () => recomputeBatch(batchId.value),
  onSuccess: async (result) => {
    Message.success(
      `已按最新规则重算 ${result.recomputedCount} 处未批准区域，${result.pinnedCount} 处已确认/已批准区域保持固定`,
    )
    await refresh()
  },
  onError: (error: unknown) => Message.error(toApiError(error).message),
})

const refresh = async () => {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['batch', batchId.value] }),
    queryClient.invalidateQueries({ queryKey: ['batches'] }),
    queryClient.invalidateQueries({ queryKey: ['runs'] }),
    queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
  ])
}

const discardMutation = useMutation({
  mutationFn: discardDraft,
  onSuccess: async () => {
    Message.success('草稿已丢弃')
    await queryClient.invalidateQueries({ queryKey: ['drafts'] })
  },
  onError: (error: unknown) => Message.error(toApiError(error).message),
})

const confirmDiscard = (draftId: string) => {
  Modal.warning({
    title: '丢弃冲突草稿',
    content: '丢弃后该窗口填写的审批表单将无法恢复，确认继续？',
    hideCancel: false,
    onOk: () => discardMutation.mutate(draftId),
  })
}

const regionStats = (itemId: string) => {
  const item = batch.value?.items.find((candidate) => candidate.id === itemId)
  if (!item) return { pending: 0, ignored: 0, confirmed: 0 }
  return {
    pending: item.regions.filter((region) => region.decision !== 'ignored' && region.decision !== 'confirmed').length,
    ignored: item.regions.filter((region) => region.decision === 'ignored').length,
    confirmed: item.regions.filter((region) => region.decision === 'confirmed').length,
  }
}

const loadDraft = (itemId: string, draftId: string) => {
  const runId = batch.value?.items.find((item) => item.id === itemId)?.primaryRunId
  if (runId) void router.push({ path: `/runs/${runId}`, query: { draft: draftId } })
}
</script>

<template>
  <a-spin :loading="isLoading" style="width: 100%">
    <template v-if="batch">
      <section class="detail-heading">
        <div>
          <a-space>
            <h2>{{ batch.name }}</h2>
            <a-tag :color="batch.stage === 'completed' ? 'green' : batch.stage === 'in-review' ? 'arcoblue' : 'orange'">
              {{ stageLabel }}
            </a-tag>
            <a-tag>v{{ batch.version }}</a-tag>
          </a-space>
          <p>{{ projectName(batch.projectId) }} · 构建 <code>{{ batch.build }}</code> · 创建于 {{ batch.createdAt.slice(5, 16).replace('T', ' ') }}</p>
        </div>
        <a-space>
          <a-button @click="router.push('/runs')"><icon-left /> 返回运行列表</a-button>
          <a-button
            v-if="batch.stage === 'collecting'"
            type="primary"
            :loading="startMutation.isPending.value"
            @click="startMutation.mutate()"
          >
            <icon-lock /> 进入评审并固定规则
          </a-button>
          <a-popconfirm
            v-else-if="stale"
            content="只重算未批准条目中的未固定区域，已确认区域和旧基线依据保留"
            @ok="recomputeMutation.mutate()"
          >
            <a-button type="primary" status="warning" :loading="recomputeMutation.isPending.value">
              <icon-refresh /> 规则已变化，重算未批准部分
            </a-button>
          </a-popconfirm>
        </a-space>
      </section>

      <a-alert v-if="batch.stage === 'collecting'" type="info" style="margin-bottom: 16px">
        当前为分片收集期：同项目同一构建的执行机分片会持续归档到本批次；规则变化会实时生效，点击「进入评审」后规则快照与区域判定才固定。
      </a-alert>
      <a-alert v-else-if="stale" type="warning" style="margin-bottom: 16px">
        进入评审后有忽略规则被修改。重算只会刷新未批准页面的未固定区域；已确认区域、已批准页面和旧基线依据都不会变。
      </a-alert>
      <a-alert v-else-if="batch.stage === 'in-review'" type="success" style="margin-bottom: 16px">
        规则快照已于 {{ batch.reviewStartedAt?.slice(5, 16).replace('T', ' ') }} 固定（{{ batch.ruleSnapshots.length }} 条规则），新分片到达不影响已确认区域。
      </a-alert>

      <div class="run-facts">
        <div><span>待评审页面</span><strong>{{ stats.pending }}</strong></div>
        <div><span>已批准</span><strong class="approved">{{ stats.approved }}</strong></div>
        <div><span>已驳回</span><strong class="rejected">{{ stats.rejected }}</strong></div>
        <div><span>已归档分片</span><strong>{{ stats.fragments }}</strong></div>
      </div>

      <a-alert v-for="draft in batchDrafts" :key="draft.id" type="warning" style="margin-bottom: 12px">
        <template #title>冲突草稿：并发提交未保存</template>
        <div class="draft-row">
          <span>
            {{ draft.reason }}；草稿结论为「{{ draft.payload.decision === 'approved' ? '批准为新基线' : '驳回' }}」，
            原因：{{ draft.payload.reason }}
          </span>
          <a-space>
            <a-button size="small" type="primary" @click="loadDraft(draft.itemId, draft.id)">载入草稿</a-button>
            <a-button size="small" status="danger" @click="confirmDiscard(draft.id)">丢弃</a-button>
          </a-space>
        </div>
      </a-alert>

      <a-card class="table-panel" :bordered="false">
        <template #title>批次页面条目</template>
        <template #extra><span class="muted">同页面重复分片自动归档，不生成重复工单</span></template>
        <a-table :data="batch.items" :pagination="false" row-key="id">
          <template #columns>
            <a-table-column title="页面 / 设备" :width="240">
              <template #cell="{ record }">
                <div class="primary-cell">
                  <router-link :to="`/runs/${record.primaryRunId}`">
                    <strong>{{ record.page }}</strong>
                  </router-link>
                  <span>{{ record.device }} · {{ record.theme === 'light' ? '浅色' : '深色' }}</span>
                </div>
              </template>
            </a-table-column>
            <a-table-column title="差异区域" :width="220">
              <template #cell="{ record }">
                <a-space size="small">
                  <a-tag color="red" v-if="regionStats(record.id).pending">{{ regionStats(record.id).pending }} 待判定</a-tag>
                  <a-tag color="gray" v-if="regionStats(record.id).ignored">{{ regionStats(record.id).ignored }} 已忽略</a-tag>
                  <a-tag color="green" v-if="regionStats(record.id).confirmed">{{ regionStats(record.id).confirmed }} 已确认</a-tag>
                </a-space>
              </template>
            </a-table-column>
            <a-table-column title="分片归档" :width="130">
              <template #cell="{ record }">
                <a-tooltip v-if="record.archivedFragments.length">
                  <a-tag color="arcoblue">{{ record.archivedFragments.length }} 个分片</a-tag>
                  <template #content>
                    <div v-for="fragment in record.archivedFragments" :key="fragment.runId">
                      {{ fragment.executor }} · #{{ fragment.fragmentIndex }} · {{ fragment.regionCount }} 区域 · {{ fragment.receivedAt.slice(5, 16).replace('T', ' ') }}
                    </div>
                  </template>
                </a-tooltip>
                <span v-else class="muted">仅主分片</span>
              </template>
            </a-table-column>
            <a-table-column title="状态" :width="110">
              <template #cell="{ record }"><StatusTag :status="record.status" /></template>
            </a-table-column>
            <a-table-column title="最近判定" :width="170">
              <template #cell="{ record }">
                <span v-if="record.review">{{ record.review.reviewer }} · {{ record.review.reviewedAt.slice(5, 16).replace('T', ' ') }}</span>
                <span v-else class="muted">尚未评审</span>
              </template>
            </a-table-column>
            <a-table-column title="操作" :width="120">
              <template #cell="{ record }">
                <router-link :to="`/runs/${record.primaryRunId}`">
                  {{ record.status === 'pending' ? '继续评审' : '查看记录' }}
                </router-link>
              </template>
            </a-table-column>
          </template>
        </a-table>
      </a-card>

      <a-card v-if="batches && batches.length > 1" class="table-panel" :bordered="false" style="margin-top: 16px">
        <template #title>同项目其他评审批次</template>
        <a-table :data="batches.filter((item) => item.id !== batch?.id)" :pagination="false" row-key="id" size="small">
          <template #columns>
            <a-table-column title="批次" :width="240">
              <template #cell="{ record }">
                <router-link :to="`/batches/${record.id}`">{{ record.name }}</router-link>
              </template>
            </a-table-column>
            <a-table-column title="构建" data-index="build" :width="180" />
            <a-table-column title="阶段" :width="120">
              <template #cell="{ record }">
                {{ stageLabelOf(record.stage) }}
              </template>
            </a-table-column>
            <a-table-column title="页面条目" :width="100">
              <template #cell="{ record }">{{ record.items.length }}</template>
            </a-table-column>
          </template>
        </a-table>
      </a-card>
    </template>
  </a-spin>
</template>
