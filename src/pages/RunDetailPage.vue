<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { Message } from '@arco-design/web-vue'
import DiffCanvas from '@/components/DiffCanvas.vue'
import StatusTag from '@/components/StatusTag.vue'
import {
  discardDraft,
  getBatch,
  getDrafts,
  getRun,
  setRegionDecision,
  submitItemReview,
  toApiError,
} from '@/api/http'
import { useReviewStore } from '@/stores/review'
import type { DifferenceRegion, ReviewCategory } from '@/types'

interface ReviewForm {
  category: ReviewCategory
  decision: 'approved' | 'rejected'
  reviewer: string
  reason: string
}

const route = useRoute()
const router = useRouter()
const queryClient = useQueryClient()
const reviewStore = useReviewStore()
const runId = computed(() => String(route.params.id))
const draftId = computed(() => (typeof route.query.draft === 'string' ? route.query.draft : ''))

const form = reactive<ReviewForm>({
  category: 'design-change',
  decision: 'approved',
  reviewer: '林默',
  reason: '',
})
const idempotencyKey = ref('')
const loadedDraftId = ref('')
const conflictMessage = ref('')

const { data: run } = useQuery({
  queryKey: computed(() => ['run', runId.value]),
  queryFn: () => getRun(runId.value),
})

// 归档分片的页面入口照旧可打开，直接切到主分片的评审视图
const effectiveRunId = computed(() => run.value?.fragmentOfRunId ?? runId.value)

const { data: primaryRun, isLoading } = useQuery({
  queryKey: computed(() => ['run', effectiveRunId.value]),
  queryFn: () => getRun(effectiveRunId.value),
  enabled: computed(() => Boolean(run.value)),
})

const batchId = computed(() => primaryRun.value?.batchId ?? '')
const { data: batch } = useQuery({
  queryKey: computed(() => ['batch', batchId.value]),
  queryFn: () => getBatch(batchId.value),
  enabled: computed(() => Boolean(batchId.value)),
})

const { data: drafts } = useQuery({ queryKey: ['drafts'], queryFn: getDrafts })

const item = computed(() =>
  batch.value?.items.find((candidate) => candidate.primaryRunId === effectiveRunId.value) ??
  batch.value?.items.find((candidate) => candidate.id === primaryRun.value?.itemId),
)

const locked = computed(() => item.value?.status !== 'pending')
const version = computed(() => batch.value?.version ?? 0)

watch(
  item,
  (value) => {
    reviewStore.setDifferenceFilter('all')
    if (value?.review && !loadedDraftId.value) {
      form.category = value.review.category
      form.decision = value.review.decision
      form.reviewer = value.review.reviewer
      form.reason = value.review.reason
    }
  },
  { immediate: true },
)

// 从批次页载入后到窗口的冲突草稿
watch(
  drafts,
  (list) => {
    if (!draftId.value || loadedDraftId.value === draftId.value || !list) return
    const draft = list.find((candidate) => candidate.id === draftId.value)
    if (!draft) return
    Object.assign(form, draft.payload)
    loadedDraftId.value = draft.id
    conflictMessage.value = `${draft.reason}。表单已从草稿恢复，确认后可基于最新版本重新提交，原草稿会自动清除。`
  },
  { immediate: true },
)

const visibleRegions = computed<DifferenceRegion[]>(() =>
  (item.value?.regions ?? []).filter(
    (region) =>
      reviewStore.differenceFilter === 'all' || region.severity === reviewStore.differenceFilter,
  ),
)

const suspiciousPixels = computed(() =>
  (item.value?.regions ?? [])
    .filter((region) => region.decision !== 'ignored')
    .reduce((total, region) => total + region.pixels, 0),
)

const archivedFragments = computed(() => item.value?.archivedFragments ?? [])

const stageText = computed(() => {
  if (!batch.value) return ''
  return { collecting: '分片收集期', 'in-review': '评审中', completed: '评审完成' }[batch.value.stage]
})

const invalidateAll = async () => {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['batch'] }),
    queryClient.invalidateQueries({ queryKey: ['batches'] }),
    queryClient.invalidateQueries({ queryKey: ['run'] }),
    queryClient.invalidateQueries({ queryKey: ['runs'] }),
    queryClient.invalidateQueries({ queryKey: ['baselines'] }),
    queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
    queryClient.invalidateQueries({ queryKey: ['drafts'] }),
  ])
}

const reviewMutation = useMutation({
  mutationFn: () => {
    if (!batch.value || !item.value) throw new Error('批次数据尚未加载')
    if (!idempotencyKey.value) idempotencyKey.value = `review-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    return submitItemReview(batch.value.id, item.value.id, {
      ...form,
      expectedVersion: version.value,
      idempotencyKey: idempotencyKey.value,
    })
  },
  onSuccess: async () => {
    Message.success(form.decision === 'approved' ? '审批通过，新基线已留痕，旧基线保留可追溯' : '已驳回并保留原基线依据')
    if (loadedDraftId.value) {
      try {
        await discardDraft(loadedDraftId.value)
      } catch {
        // 草稿清理失败不阻断主流程，可在批次页再次处理
      }
      loadedDraftId.value = ''
    }
    idempotencyKey.value = ''
    conflictMessage.value = ''
    await invalidateAll()
    if (batch.value && batch.value.items.every((entry) => entry.status !== 'pending')) {
      await router.push(`/batches/${batch.value.id}`)
    }
  },
  onError: async (error: unknown) => {
    const apiError = toApiError(error)
    conflictMessage.value = apiError.message
    idempotencyKey.value = ''
    Message.error(apiError.message)
    await invalidateAll()
  },
})

const regionMutation = useMutation({
  mutationFn: ({ region, decision }: { region: DifferenceRegion; decision: 'ignored' | 'confirmed' }) => {
    if (!batch.value || !item.value) throw new Error('批次数据尚未加载')
    return setRegionDecision(batch.value.id, item.value.id, region.id, decision, version.value)
  },
  onSuccess: async () => {
    await invalidateAll()
  },
  onError: async (error: unknown) => {
    const apiError = toApiError(error)
    Message.error(apiError.message)
    await invalidateAll()
  },
})

const cycleRegion = (target: DifferenceRegion) => {
  if (!batch.value || locked.value) return
  if (batch.value.stage === 'collecting') {
    Message.warning('批次尚在分片收集期，请先在批次页进入评审，区域判定才会固定')
    return
  }
  // 待判定 → 忽略 → 确认 → 待判定；已固定判定随状态一并冻结
  const decision =
    target.decision === 'ignored' ? 'confirmed' : target.decision === 'confirmed' ? 'ignored' : 'ignored'
  regionMutation.mutate({ region: target, decision })
}

const handleDifferenceFilter = (value: string | number | boolean) => {
  const allowed = ['all', 'high', 'medium', 'low']
  if (allowed.includes(String(value))) {
    reviewStore.setDifferenceFilter(String(value) as 'all' | 'high' | 'medium' | 'low')
  }
}

const submitReview = () => {
  if (!batch.value) {
    Message.warning('批次数据尚未加载完成')
    return
  }
  if (batch.value.stage === 'collecting') {
    Message.warning('请先在批次页点击「进入评审并固定规则」后再提交')
    return
  }
  if (!form.reason.trim()) {
    Message.warning('请填写审批原因')
    return
  }
  reviewMutation.mutate()
}

const regionLabel = (region: DifferenceRegion) => {
  if (region.decision === 'confirmed') return '已确认'
  if (region.decision === 'ignored') return region.source === 'rule' ? '规则忽略' : '已忽略'
  return '待判定'
}
</script>

<template>
  <a-spin :loading="isLoading" style="width: 100%">
    <template v-if="primaryRun && item && batch">
      <section class="detail-heading">
        <div>
          <a-space>
            <h2>{{ primaryRun.name }}</h2>
            <StatusTag :status="item.status" />
            <a-tag color="arcoblue">{{ stageText }} · v{{ batch.version }}</a-tag>
          </a-space>
          <p>
            {{ item.page }} · {{ item.device }} · {{ item.theme === 'light' ? '浅色主题' : '深色主题' }}
            · 批次 <router-link :to="`/batches/${batch.id}`">{{ batch.name }}</router-link>
          </p>
        </div>
        <a-space>
          <a-button @click="router.push(`/batches/${batch.id}`)"><icon-left /> 返回批次</a-button>
          <a-button
            v-if="!locked"
            type="primary"
            :loading="reviewMutation.isPending.value"
            @click="submitReview"
          >
            <icon-check /> 提交本页审批
          </a-button>
        </a-space>
      </section>

      <a-alert v-if="run?.fragmentOfRunId" type="info" style="margin-bottom: 16px">
        当前查看的是执行机 #{{ run.fragmentIndex ?? '' }} 回传的重复分片（{{ run.id }}），已归档到主运行
        <router-link :to="`/runs/${effectiveRunId}`">{{ effectiveRunId }}</router-link>，
        差异区域按几何位置去重合并，不生成重复工单。
      </a-alert>

      <a-alert v-if="batch.stage === 'collecting'" type="info" style="margin-bottom: 16px">
        批次仍在收集分片：规则与区域判定尚未固定。请到
        <router-link :to="`/batches/${batch.id}`">批次页</router-link>进入评审后再做区域判定与审批。
      </a-alert>
      <a-alert v-else-if="locked" :type="item.status === 'approved' ? 'success' : 'error'" style="margin-bottom: 16px">
        <template v-if="item.status === 'approved'">
          该页面已于 {{ item.review?.reviewedAt.slice(5, 16).replace('T', ' ') }} 由
          {{ item.review?.reviewer }} 批准为新基线；区域判定与旧基线依据已冻结，晚到分片只归档不重开。
        </template>
        <template v-else>
          该页面已驳回，驳回依据保留；新分片到达只进入未批准重算，不会覆盖本结论。
        </template>
      </a-alert>
      <a-alert v-if="conflictMessage" type="warning" style="margin-bottom: 16px">
        {{ conflictMessage }}
      </a-alert>

      <div class="run-facts">
        <div><span>差异率</span><strong :class="{ danger: primaryRun.mismatchRate >= 5 }">{{ item.mismatchRate.toFixed(2) }}%</strong></div>
        <div><span>待判定像素</span><strong>{{ suspiciousPixels.toLocaleString() }}</strong></div>
        <div><span>主运行标识</span><strong>{{ primaryRun.id }}</strong></div>
        <div><span>构建链路</span><strong>{{ primaryRun.baselineVersion }} → {{ primaryRun.currentVersion }}</strong></div>
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
            <DiffCanvas :run="primaryRun" side="baseline" :zoom="reviewStore.zoom" :regions="visibleRegions" />
            <DiffCanvas :run="primaryRun" side="current" :zoom="reviewStore.zoom" :regions="visibleRegions" />
          </div>

          <a-card v-if="archivedFragments.length" class="table-panel fragment-card" :bordered="false">
            <template #title>晚到分片归档（{{ archivedFragments.length }}）</template>
            <template #extra><span class="muted">重复分片只归档一次，批准后到达也不绕过基线</span></template>
            <a-table :data="archivedFragments" :pagination="false" row-key="runId" size="small">
              <template #columns>
                <a-table-column title="分片运行" data-index="runId" :width="160" />
                <a-table-column title="执行机" data-index="executor" :width="160" />
                <a-table-column title="序号" data-index="fragmentIndex" :width="70" />
                <a-table-column title="回传时间" :width="150">
                  <template #cell="{ record }">{{ record.receivedAt.slice(5, 16).replace('T', ' ') }}</template>
                </a-table-column>
                <a-table-column title="携带区域" data-index="regionCount" :width="100" />
              </template>
            </a-table>
          </a-card>
        </div>

        <aside class="review-panel">
          <div class="panel-title">
            <div>
              <h3>差异区域</h3>
              <span>
                快照固定于 {{ batch.reviewStartedAt?.slice(5, 16).replace('T', ' ') ?? '尚未进入评审' }}
              </span>
            </div>
            <a-tag color="red">{{ item.regions.filter((entry) => entry.decision !== 'ignored').length }} 待判定</a-tag>
          </div>
          <div class="region-list">
            <button
              v-for="region in visibleRegions"
              :key="region.id"
              class="region-item"
              :class="{
                ignored: region.decision === 'ignored',
                confirmed: region.decision === 'confirmed',
                pinned: region.pinned,
                locked: locked || batch.stage === 'collecting',
              }"
              :disabled="locked || batch.stage === 'collecting'"
              @click="cycleRegion(region)"
            >
              <span class="region-severity" :class="region.severity">{{ region.severity.toUpperCase() }}</span>
              <span class="region-copy">
                <strong>{{ region.kind === 'layout' ? '布局位移' : region.kind === 'color' ? '色彩变化' : region.kind === 'content' ? '内容变更' : '环境噪声' }}</strong>
                <small>区域 {{ region.x }}%, {{ region.y }}% · {{ region.pixels.toLocaleString() }} px</small>
              </span>
              <span class="ignore-action">
                {{ regionLabel(region) }}
                <a-tag v-if="region.pinned && region.source === 'manual'" size="small" color="green">已固定</a-tag>
              </span>
            </button>
          </div>
          <p class="muted region-hint">点击区域循环：待判定 → 手工忽略 → 确认差异；进入评审后的手工判定与规则快照一起固定，重算不会改动。</p>

          <a-divider />

          <div class="panel-title">
            <div>
              <h3>评审结论</h3>
              <span>原因、批准人和新版基线会永久留痕</span>
            </div>
          </div>
          <a-form :model="form" layout="vertical">
            <a-form-item field="category" label="变化类型" :rules="[{ required: true, message: '请选择变化类型' }]">
              <a-select v-model="form.category" :disabled="locked">
                <a-option value="design-change">设计变更</a-option>
                <a-option value="render-error">渲染异常</a-option>
                <a-option value="environment-noise">环境噪声</a-option>
              </a-select>
            </a-form-item>
            <a-form-item field="decision" label="审批结论" :rules="[{ required: true, message: '请选择审批结论' }]">
              <a-radio-group v-model="form.decision" type="button" :disabled="locked">
                <a-radio value="approved">批准为新基线</a-radio>
                <a-radio value="rejected">驳回归</a-radio>
              </a-radio-group>
            </a-form-item>
            <a-form-item field="reviewer" label="批准人" :rules="[{ required: true, message: '请填写批准人' }]">
              <a-input v-model="form.reviewer" :disabled="locked" />
            </a-form-item>
            <a-form-item
              field="reason"
              label="审批原因"
              :rules="[
                { required: true, message: '请填写审批原因' },
                { minLength: 8, message: '审批原因至少 8 个字符' },
              ]"
            >
              <a-textarea
                v-model="form.reason"
                :auto-size="{ minRows: 4, maxRows: 7 }"
                :disabled="locked"
                placeholder="说明业务需求、设计稿或异常依据"
              />
            </a-form-item>
            <a-alert v-if="form.decision === 'approved' && !locked" type="warning" style="margin-bottom: 16px">
              批准基于当前版本 v{{ batch.version }} 提交：并发窗口后到的保存会失败并留草稿；批准只新增基线版本，旧基线仍可追溯。
            </a-alert>
            <a-button
              v-if="!locked"
              type="primary"
              long
              :loading="reviewMutation.isPending.value"
              @click="submitReview"
            >
              确认{{ form.decision === 'approved' ? '批准并创建基线' : '驳回' }}
            </a-button>
          </a-form>

          <div v-if="item.review" class="review-record">
            <h4>审批留痕</h4>
            <dl>
              <dt>结论</dt><dd>{{ item.review.decision === 'approved' ? '已批准' : '已驳回' }}</dd>
              <dt>类型</dt><dd>{{ item.review.category }}</dd>
              <dt>人员</dt><dd>{{ item.review.reviewer }}</dd>
              <dt>批次版本</dt><dd>v{{ item.review.batchVersion ?? '-' }}</dd>
              <dt>时间</dt><dd>{{ item.review.reviewedAt.slice(0, 16).replace('T', ' ') }}</dd>
              <dt v-if="item.previousBaselineId">旧基线</dt>
              <dd v-if="item.previousBaselineId"><code>{{ item.previousBaselineId }}</code>（已停用保留）</dd>
            </dl>
            <p>{{ item.review.reason }}</p>
          </div>
        </aside>
      </div>
    </template>
  </a-spin>
</template>
