<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { Message } from '@arco-design/web-vue'
import DiffCanvas from '@/components/DiffCanvas.vue'
import {
  discardDraft,
  enterRunReview,
  getConflictData,
  getRun,
  recomputeBatch,
  submitBatchReview,
  toggleBatchRegion,
} from '@/api/http'
import { useReviewStore } from '@/stores/review'
import type { ReviewPayload } from '@/types'

const route = useRoute()
const router = useRouter()
const queryClient = useQueryClient()
const reviewStore = useReviewStore()
const runId = computed(() => String(route.params.id))

const activeShardRunId = ref<string>('')
const submitOpId = ref('')

const form = reactive<ReviewPayload>({
  category: 'design-change',
  decision: 'approved',
  reviewer: '林默',
  reason: '',
})

watch(
  runId,
  () => {
    activeShardRunId.value = ''
    submitOpId.value = ''
    reviewStore.setDifferenceFilter('all')
  },
  { immediate: true },
)

const { data: run, isLoading: runLoading } = useQuery({
  queryKey: computed(() => ['run', runId.value]),
  queryFn: () => getRun(runId.value),
})

// 进入评审即幂等：旧运行首次打开补建单运行批次，并固定规则快照 + 区域判定
const {
  data: batch,
  isLoading: batchLoading,
  refetch: refetchBatch,
} = useQuery({
  queryKey: computed(() => ['batch-by-run', runId.value]),
  queryFn: () => enterRunReview(runId.value),
  enabled: computed(() => Boolean(run.value)),
})

const activeRound = computed(() => batch.value?.rounds.find((round) => round.status === 'open'))
const currentRoundNo = computed(() => activeRound.value?.round ?? batch.value?.currentRound ?? 1)

const shards = computed(() => batch.value?.shards ?? [])
const activeShard = computed(
  () => shards.value.find((shard) => shard.run.id === activeShardRunId.value) ?? shards.value[0],
)

const lockedShardRunIds = computed(() => {
  const approved = new Set<string>()
  for (const approval of batch.value?.approvals ?? []) {
    if (approval.decision === 'approved') approval.runIds.forEach((id) => approved.add(id))
  }
  return approved
})

const visibleRegions = computed(() =>
  (activeShard.value?.regions ?? []).filter(
    (region) =>
      reviewStore.differenceFilter === 'all' || region.severity === reviewStore.differenceFilter,
  ),
)

const allRegions = computed(() => shards.value.flatMap((shard) => shard.regions))
const pendingRegions = computed(() => allRegions.value.filter((region) => !region.state.ignored))
const suspiciousPixels = computed(() =>
  pendingRegions.value.reduce((total, region) => total + region.pixels, 0),
)
const pendingShards = computed(
  () => batch.value?.pendingRunIds.map((id) => shards.value.find((s) => s.run.id === id)?.run).filter(Boolean) ?? [],
)

const canReview = computed(() => {
  if (!batch.value || !activeRound.value) return false
  return !lockedShardRunIds.value.has(activeShard.value?.run.id ?? '')
})

const refreshAll = async () => {
  await queryClient.invalidateQueries({ queryKey: ['batch'] })
  await refetchBatch()
  await queryClient.invalidateQueries({ queryKey: ['runs'] })
  await queryClient.invalidateQueries({ queryKey: ['baselines'] })
  await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
}

const regionMutation = useMutation({
  mutationFn: (variables: { runId: string; regionId: string; ignored: boolean }) =>
    toggleBatchRegion(batch.value!.id, {
      ...variables,
      revision: batch.value!.revision,
    }),
  onSuccess: async () => {
    await refreshAll()
  },
  onError: async (error: unknown) => {
    const conflict = getConflictData(error)
    if (conflict) {
      Message.warning(conflict.message)
      await refreshAll()
    } else {
      Message.error((error as Error).message)
    }
  },
})

const recomputeMutation = useMutation({
  mutationFn: () => recomputeBatch(batch.value!.id, batch.value!.revision),
  onSuccess: async (detail) => {
    Message.success(`已按最新规则重算第 ${detail.currentRound} 轮，已确认区域保持不变`)
    await refreshAll()
  },
  onError: async (error: unknown) => {
    const conflict = getConflictData(error)
    if (conflict) {
      Message.warning(conflict.message)
      await refreshAll()
    } else {
      Message.error((error as Error).message)
    }
  },
})

const submitMutation = useMutation({
  mutationFn: () => {
    submitOpId.value ||= `op-submit-${batch.value!.id}-r${currentRoundNo.value}-${Date.now().toString(36)}`
    return submitBatchReview(batch.value!.id, {
      ...form,
      revision: batch.value!.revision,
      round: currentRoundNo.value,
      opId: submitOpId.value,
    })
  },
  onSuccess: async (updated) => {
    submitOpId.value = ''
    Message.success(
      updated.status === 'approved'
        ? `第 ${currentRoundNo.value} 轮已批准，新基线已留痕，旧基线仍可追溯`
        : `第 ${currentRoundNo.value} 轮已驳回，原基线保留`,
    )
    await refreshAll()
    await router.push('/approvals')
  },
  onError: async (error: unknown) => {
    const conflict = getConflictData(error)
    if (conflict) {
      // 后到的提交保存失败：服务端已留下草稿，刷新到新版本供评审人核对
      Message.error(conflict.message)
      await refreshAll()
    } else {
      Message.error((error as Error).message)
    }
  },
})

const toggleIgnored = (target: { state: { runId: string; regionId: string; ignored: boolean } }) => {
  if (lockedShardRunIds.value.has(target.state.runId)) {
    Message.info('该区域属于已批准轮次，已随基线锁定')
    return
  }
  regionMutation.mutate({
    runId: target.state.runId,
    regionId: target.state.regionId,
    ignored: !target.state.ignored,
  })
}

const handleDifferenceFilter = (value: string | number | boolean) => {
  const allowed = ['all', 'high', 'medium', 'low']
  if (allowed.includes(String(value))) {
    reviewStore.setDifferenceFilter(String(value) as 'all' | 'high' | 'medium' | 'low')
  }
}

const submitReview = () => {
  if (!form.reason.trim()) {
    Message.warning('请填写审批原因')
    return
  }
  if (!activeRound.value) {
    Message.warning('当前批次没有进行中的评审轮次')
    return
  }
  submitMutation.mutate()
}

const applyDraft = () => {
  const draft = batch.value?.draft
  if (!draft) return
  Object.assign(form, draft.form)
  Message.info('已载入冲突时保存的草稿，请核对后重新提交')
}

const dropDraft = async () => {
  if (!batch.value?.draft) return
  await discardDraft(batch.value.id)
  await refreshAll()
  Message.success('草稿已丢弃')
}

const roundLabel = (status: string) =>
  ({ open: '评审中', approved: '已批准', rejected: '已驳回', superseded: '已续算' })[status] ?? status

const kindLabel = (kind: string) =>
  kind === 'layout'
    ? '布局位移'
    : kind === 'color'
      ? '色彩变化'
      : kind === 'content'
        ? '内容变更'
        : '环境噪声'
</script>

<template>
  <a-spin :loading="runLoading || batchLoading" style="width: 100%">
    <template v-if="run && batch && activeShard">
      <section class="detail-heading">
        <div>
          <a-space>
            <h2>{{ run.name }}</h2>
            <a-tag color="arcoblue" size="large">批次 {{ batch.id.slice(-6) }}</a-tag>
            <a-tag v-if="shards.length > 1" color="purple">{{ shards.length }} 个分片 · 第 {{ currentRoundNo }} 轮</a-tag>
          </a-space>
          <p>{{ run.page }} · {{ run.device }} · {{ run.theme === 'light' ? '浅色主题' : '深色主题' }} · 构建 <code>{{ run.build }}</code></p>
        </div>
        <a-space>
          <a-button @click="router.push('/runs')"><icon-left /> 返回列表</a-button>
          <a-button
            type="primary"
            :disabled="!canReview"
            :loading="submitMutation.isPending.value"
            @click="submitReview"
          >
            <icon-check /> 提交第 {{ currentRoundNo }} 轮评审
          </a-button>
        </a-space>
      </section>

      <a-alert v-if="batch.draft" type="error" style="margin-bottom: 12px">
        <template #title>该批次有一个并发提交失败后保存的草稿</template>
        草稿基于修订号 {{ batch.draft.attemptedRevision }}，当前批次已到 {{ batch.draft.serverRevision }}：{{ batch.draft.conflict }}
        <template #action>
          <a-space>
            <a-button size="mini" type="primary" @click="applyDraft">载入草稿</a-button>
            <a-button size="mini" @click="dropDraft">丢弃</a-button>
          </a-space>
        </template>
      </a-alert>

      <a-alert
        v-if="batch.rulesChanged"
        type="warning"
        style="margin-bottom: 12px"
        :action-icon="false"
      >
        <template #title>忽略规则在进入评审后发生变化</template>
        规则快照已在进入评审时固定。仅未确认区域会按新规则重算，已确认区域不受影响。
        <template #action>
          <a-button size="mini" type="primary" :loading="recomputeMutation.isPending.value" @click="recomputeMutation.mutate()">
            重算未判定区域
          </a-button>
        </template>
      </a-alert>

      <a-alert
        v-if="shards.length > 1 && batch.approvals.length > 0"
        type="info"
        style="margin-bottom: 12px"
      >
        晚到分片到达后批次已续算：历史 {{ batch.approvals.length }} 次审批结论、已确认区域与旧基线均保留，当前只需评审新分片。
      </a-alert>

      <div class="run-facts">
        <div><span>差异率（当前分片）</span><strong :class="{ danger: activeShard.run.mismatchRate >= 5 }">{{ activeShard.run.mismatchRate.toFixed(2) }}%</strong></div>
        <div><span>待判定像素</span><strong>{{ suspiciousPixels.toLocaleString() }}</strong></div>
        <div><span>待评审分片</span><strong>{{ pendingShards.length }} / {{ shards.length }}</strong></div>
        <div><span>构建链路</span><strong>{{ activeShard.run.baselineVersion }} → {{ activeShard.run.currentVersion }}</strong></div>
      </div>

      <div class="batch-strip">
        <div class="shard-tabs">
          <button
            v-for="shard in shards"
            :key="shard.run.id"
            class="shard-tab"
            :class="{
              active: shard.run.id === activeShard.run.id,
              locked: lockedShardRunIds.has(shard.run.id),
            }"
            @click="activeShardRunId = shard.run.id"
          >
            <span class="shard-name">
              {{ shard.run.executor ?? '执行机' }} #{{ shard.run.shardIndex ?? 0 }}
            </span>
            <span class="shard-meta">{{ shard.run.id }}</span>
            <a-tag v-if="lockedShardRunIds.has(shard.run.id)" color="green" size="small">已批准锁定</a-tag>
            <a-tag v-else color="orange" size="small">待评审</a-tag>
          </button>
        </div>
        <div class="round-track">
          <span
            v-for="round in batch.rounds"
            :key="round.round"
            class="round-pill"
            :class="round.status"
            :title="`第 ${round.round} 轮 · ${roundLabel(round.status)}`"
          >R{{ round.round }} · {{ roundLabel(round.status) }}</span>
        </div>
      </div>

      <div class="review-workspace">
        <div class="comparison-area">
          <div class="compare-toolbar">
            <a-space>
              <span class="toolbar-label">差异筛选</span>
              <a-radio-group
                type="button"
                :model-value="reviewStore.differenceFilter"
                size="small"
                @change="handleDifferenceFilter"
              >
                <a-radio value="all">全部</a-radio>
                <a-radio value="high">高</a-radio>
                <a-radio value="medium">中</a-radio>
                <a-radio value="low">低</a-radio>
              </a-radio-group>
            </a-space>
            <a-space>
              <a-button-group size="small">
                <a-button @click="reviewStore.setZoom(reviewStore.zoom - 10)"><icon-zoom-out /></a-button>
                <a-button>{{ reviewStore.zoom }}%</a-button>
                <a-button @click="reviewStore.setZoom(reviewStore.zoom + 10)"><icon-zoom-in /></a-button>
              </a-button-group>
              <a-button size="small" @click="reviewStore.setZoom(100)"><icon-refresh /> 复位</a-button>
            </a-space>
          </div>
          <div class="canvas-grid">
            <DiffCanvas :run="activeShard.run" side="baseline" :zoom="reviewStore.zoom" :regions="visibleRegions" />
            <DiffCanvas :run="activeShard.run" side="current" :zoom="reviewStore.zoom" :regions="visibleRegions" />
          </div>
        </div>

        <aside class="review-panel">
          <div class="panel-title">
            <div>
              <h3>差异区域 · 第 {{ currentRoundNo }} 轮</h3>
              <span>
                规则快照 {{ (batch.snapshots.find((s) => activeRound && s.id === activeRound.snapshotId)?.hash ?? '—') }}
                已固定
              </span>
            </div>
            <a-tag color="red">{{ pendingRegions.length }} 待判定</a-tag>
          </div>
          <div class="region-list">
            <button
              v-for="region in visibleRegions"
              :key="`${region.state.runId}-${region.id}`"
              class="region-item"
              :class="{
                ignored: region.state.ignored,
                locked: lockedShardRunIds.has(region.state.runId),
              }"
              :disabled="lockedShardRunIds.has(region.state.runId)"
              @click="toggleIgnored(region)"
            >
              <span class="region-severity" :class="region.severity">{{ region.severity.toUpperCase() }}</span>
              <span class="region-copy">
                <strong>{{ kindLabel(region.kind) }}</strong>
                <small>
                  {{ region.state.runId.slice(-6) }} · 区域 {{ region.x }}%, {{ region.y }}% ·
                  {{ region.pixels.toLocaleString() }} px
                  <em v-if="region.state.manual">· 人工确认</em>
                  <em v-else-if="region.ruleId">· 规则 {{ region.ruleId }}</em>
                </small>
              </span>
              <span class="ignore-action">
                <template v-if="lockedShardRunIds.has(region.state.runId)">已锁定</template>
                <template v-else>{{ region.state.ignored ? '恢复' : '忽略' }}</template>
              </span>
            </button>
          </div>

          <a-divider />

          <div class="panel-title">
            <div>
              <h3>评审结论</h3>
              <span>只覆盖未批准分片；原因、批准人和新基线永久留痕</span>
            </div>
          </div>
          <a-form :model="form" layout="vertical" @submit-success="submitReview">
            <a-form-item field="category" label="变化类型">
              <a-select v-model="form.category">
                <a-option value="design-change">设计变更</a-option>
                <a-option value="render-error">渲染异常</a-option>
                <a-option value="environment-noise">环境噪声</a-option>
              </a-select>
            </a-form-item>
            <a-form-item field="decision" label="审批结论">
              <a-radio-group v-model="form.decision" type="button">
                <a-radio value="approved">批准为新基线</a-radio>
                <a-radio value="rejected">驳回归</a-radio>
              </a-radio-group>
            </a-form-item>
            <a-form-item field="reviewer" label="批准人">
              <a-input v-model="form.reviewer" />
            </a-form-item>
            <a-form-item field="reason" label="审批原因">
              <a-textarea
                v-model="form.reason"
                :auto-size="{ minRows: 4, maxRows: 7 }"
                placeholder="说明业务需求、设计稿或异常依据"
              />
            </a-form-item>
            <a-alert v-if="form.decision === 'approved'" type="warning" style="margin-bottom: 16px">
              批准只新增基线版本并停用当前有效基线，历史基线与已批准分片全部保留可追溯。
            </a-alert>
            <a-button
              html-type="submit"
              type="primary"
              long
              :disabled="!canReview"
              :loading="submitMutation.isPending.value"
            >
              确认{{ form.decision === 'approved' ? `批准 ${pendingShards.length} 个分片并创建基线` : '驳回当前轮次' }}
            </a-button>
          </a-form>

          <div v-if="batch.approvals.length > 0" class="review-record">
            <h4>历史审批（随批次续算保留）</h4>
            <div v-for="approval in batch.approvals" :key="approval.opId" class="approval-line">
              <dl>
                <dt>第 {{ approval.round }} 轮</dt>
                <dd>
                  <a-tag :color="approval.decision === 'approved' ? 'green' : 'red'" size="small">
                    {{ approval.decision === 'approved' ? '已批准' : '已驳回' }}
                  </a-tag>
                  {{ approval.reviewer }} · {{ approval.reviewedAt.slice(5, 16).replace('T', ' ') }}
                </dd>
              </dl>
              <p>{{ approval.reason }}</p>
            </div>
          </div>
        </aside>
      </div>
    </template>
  </a-spin>
</template>
