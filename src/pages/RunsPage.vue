<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { Message, type FileItem } from '@arco-design/web-vue'
import {
  getBatches,
  getProjects,
  getRuns,
  getRules,
  importRuns,
  mergeRuns,
  toApiError,
} from '@/api/http'
import StatusTag from '@/components/StatusTag.vue'
import { useReviewStore } from '@/stores/review'
import { snapshotIsStale } from '@/utils/batch'

const filters = reactive({
  projectId: '',
  page: '',
  device: '',
  theme: '',
  build: '',
  status: '',
  keyword: '',
})
const uploadVisible = ref(false)
const uploadFiles = ref<FileItem[]>([])
const baselineFiles = ref<FileItem[]>([])
const uploadForm = reactive({
  projectId: '',
  page: '',
  device: 'Desktop 1440',
  theme: 'light' as 'light' | 'dark',
  build: '',
  baselineVersion: '',
  currentVersion: '',
  executor: '',
})

const queryClient = useQueryClient()
const reviewStore = useReviewStore()

const cleanFilters = computed(() =>
  Object.fromEntries(Object.entries(filters).filter(([, value]) => Boolean(value))),
)

const { data: projects } = useQuery({ queryKey: ['projects'], queryFn: getProjects })
const { data: runs, isLoading } = useQuery({
  queryKey: computed(() => ['runs', cleanFilters.value]),
  queryFn: () => getRuns(cleanFilters.value),
})
const { data: batches } = useQuery({ queryKey: ['batches'], queryFn: () => getBatches() })
const { data: rules } = useQuery({ queryKey: ['rules'], queryFn: getRules })

const availablePages = computed(() => [...new Set(runs.value?.map((run) => run.page) ?? [])])
const availableDevices = computed(() => [...new Set(runs.value?.map((run) => run.device) ?? [])])
const availableBuilds = computed(() => [...new Set(runs.value?.map((run) => run.build) ?? [])])

const projectName = (id: string) =>
  projects.value?.find((project) => project.id === id)?.name ?? id

const stageMeta = (stage: 'collecting' | 'in-review' | 'completed') =>
  ({
    collecting: { label: '分片收集期', color: 'orange' },
    'in-review': { label: '评审中', color: 'arcoblue' },
    completed: { label: '评审完成', color: 'green' },
  })[stage]

const batchSummaries = computed(() =>
  (batches.value ?? []).map((batch) => {
    const pending = batch.items.filter((item) => item.status === 'pending').length
    const fragments = batch.items.reduce((sum, item) => sum + item.archivedFragments.length, 0)
    const stale = rules.value ? snapshotIsStale(batch, rules.value) : false
    return { batch, pending, fragments, stale }
  }),
)

const mergeMutation = useMutation({
  mutationFn: mergeRuns,
  onSuccess: async () => {
    Message.success('同页面重复运行已归档为分片，区域按几何位置去重，未产生重复工单')
    reviewStore.clearSelection()
    await invalidateData()
  },
  onError: (error: unknown) => Message.error(toApiError(error).message),
})

const importMutation = useMutation({
  mutationFn: importRuns,
  onSuccess: async (result) => {
    Message.success(
      result.duplicated > 0
        ? `已归档到批次，${result.duplicated} 个重复分片只入库一次，新增 ${result.runs.length - result.duplicated} 个分片`
        : `已回传 ${result.runs.length} 个分片到批次并完成基线配对`,
    )
    uploadVisible.value = false
    uploadFiles.value = []
    baselineFiles.value = []
    Object.assign(uploadForm, {
      projectId: '',
      page: '',
      device: 'Desktop 1440',
      theme: 'light',
      build: '',
      baselineVersion: '',
      currentVersion: '',
      executor: '',
    })
    await invalidateData()
  },
  onError: (error: unknown) => Message.error(toApiError(error).message),
})

const invalidateData = async () => {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['runs'] }),
    queryClient.invalidateQueries({ queryKey: ['batches'] }),
    queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
  ])
}

const resetFilters = () => {
  Object.assign(filters, {
    projectId: '',
    page: '',
    device: '',
    theme: '',
    build: '',
    status: '',
    keyword: '',
  })
}

const handleSelectionChange = (keys: Array<string | number>) => {
  reviewStore.selectedRunIds = keys.map(String)
}

const fileToDataUrl = (item: FileItem): Promise<{ name: string; size: number; dataUrl: string }> =>
  new Promise((resolve, reject) => {
    const file = item.file
    if (!file) {
      reject(new Error('截图文件读取失败'))
      return
    }
    const reader = new FileReader()
    reader.onload = () =>
      resolve({
        name: file.name,
        size: file.size,
        dataUrl: String(reader.result),
      })
    reader.onerror = () => reject(new Error(`无法读取文件 ${file.name}`))
    reader.readAsDataURL(file)
  })

const submitImport = async () => {
  const totalSize = uploadFiles.value.reduce((sum, item) => sum + (item.file?.size ?? 0), 0)
  if (uploadFiles.value.length === 0) {
    Message.warning('请至少上传一张当前图')
    return
  }
  if (totalSize > 4 * 1024 * 1024) {
    Message.warning('单次截图总大小不能超过 4MB，请压缩后重试')
    return
  }
  try {
    const files = await Promise.all(uploadFiles.value.map(fileToDataUrl))
    const baselineImage = baselineFiles.value[0]?.file
      ? (await fileToDataUrl(baselineFiles.value[0])).dataUrl
      : undefined
    importMutation.mutate({
      ...uploadForm,
      files,
      baselineImage,
      executor: uploadForm.executor.trim() || undefined,
    })
  } catch (error) {
    Message.error(error instanceof Error ? error.message : '截图读取失败')
  }
}
</script>

<template>
  <section class="page-intro compact">
    <div>
      <h2>回归运行与可续传评审批次</h2>
      <p>执行机分批回传自动归入同项目同一构建批次，同页面分片只归档一次；进入评审后规则快照固定，可随时续评。</p>
    </div>
    <a-space>
      <a-button type="primary" @click="uploadVisible = true"><icon-upload /> 回传分片</a-button>
      <a-button :disabled="reviewStore.selectedCount < 2" :loading="mergeMutation.isPending.value" @click="mergeMutation.mutate(reviewStore.selectedRunIds)">
        <icon-merge /> 归档重复分片 {{ reviewStore.selectedCount }} 条
      </a-button>
    </a-space>
  </section>

  <a-card class="table-panel" :bordered="false" style="margin-bottom: 16px">
    <template #title>评审批次</template>
    <template #extra><span class="muted">新分片持续归档，已批准页面不受晚到分片影响</span></template>
    <a-table :data="batchSummaries" :pagination="{ pageSize: 4 }" row-key="batch.id" size="small">
      <template #columns>
        <a-table-column title="批次 / 构建" :width="280">
          <template #cell="{ record }">
            <div class="primary-cell">
              <router-link :to="`/batches/${record.batch.id}`">
                <strong>{{ record.batch.name }}</strong>
              </router-link>
              <span><code>{{ record.batch.build }}</code> · {{ projectName(record.batch.projectId) }}</span>
            </div>
          </template>
        </a-table-column>
        <a-table-column title="阶段" :width="150">
          <template #cell="{ record }">
            <a-space size="small">
              <a-tag :color="stageMeta(record.batch.stage).color">{{ stageMeta(record.batch.stage).label }}</a-tag>
              <a-tag v-if="record.stale" color="red">规则已变化</a-tag>
            </a-space>
          </template>
        </a-table-column>
        <a-table-column title="页面条目" :width="110">
          <template #cell="{ record }">{{ record.batch.items.length }} 个 · {{ record.pending }} 待评</template>
        </a-table-column>
        <a-table-column title="归档分片" :width="110">
          <template #cell="{ record }">{{ record.fragments }} 个</template>
        </a-table-column>
        <a-table-column title="版本" :width="90">
          <template #cell="{ record }">v{{ record.batch.version }}</template>
        </a-table-column>
        <a-table-column title="操作" :width="120">
          <template #cell="{ record }">
            <router-link :to="`/batches/${record.batch.id}`">
              {{ record.batch.stage === 'collecting' ? '查看收集' : '续上评审' }}
            </router-link>
          </template>
        </a-table-column>
      </template>
    </a-table>
  </a-card>

  <a-card class="filter-panel" :bordered="false">
    <a-grid :cols="{ xs: 1, sm: 2, md: 3, xl: 6 }" :col-gap="12" :row-gap="12">
      <a-grid-item>
        <a-input v-model="filters.keyword" allow-clear placeholder="运行名称 / 页面 / ID">
          <template #prefix><icon-search /></template>
        </a-input>
      </a-grid-item>
      <a-grid-item>
        <a-select v-model="filters.projectId" allow-clear placeholder="全部项目">
          <a-option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</a-option>
        </a-select>
      </a-grid-item>
      <a-grid-item>
        <a-select v-model="filters.page" allow-clear placeholder="全部页面">
          <a-option v-for="page in availablePages" :key="page" :value="page">{{ page }}</a-option>
        </a-select>
      </a-grid-item>
      <a-grid-item>
        <a-select v-model="filters.device" allow-clear placeholder="全部设备">
          <a-option v-for="device in availableDevices" :key="device" :value="device">{{ device }}</a-option>
        </a-select>
      </a-grid-item>
      <a-grid-item>
        <a-select v-model="filters.theme" allow-clear placeholder="全部主题">
          <a-option value="light">浅色主题</a-option>
          <a-option value="dark">深色主题</a-option>
        </a-select>
      </a-grid-item>
      <a-grid-item>
        <a-select v-model="filters.status" allow-clear placeholder="全部状态">
          <a-option value="pending">待审批</a-option>
          <a-option value="approved">已批准</a-option>
          <a-option value="rejected">已驳回</a-option>
          <a-option value="archived">已归档分片</a-option>
        </a-select>
      </a-grid-item>
    </a-grid>
    <div class="filter-actions">
      <a-select v-model="filters.build" allow-clear placeholder="全部构建版本" style="width: 220px">
        <a-option v-for="build in availableBuilds" :key="build" :value="build">{{ build }}</a-option>
      </a-select>
      <a-button @click="resetFilters"><icon-refresh /> 重置条件</a-button>
      <span class="result-count">共 {{ runs?.length ?? 0 }} 条主运行（归档分片已折叠）</span>
    </div>
  </a-card>

  <a-card class="table-panel" :bordered="false">
    <a-table
      v-model:selected-keys="reviewStore.selectedRunIds"
      :data="runs"
      :loading="isLoading"
      :pagination="{ pageSize: 10, showTotal: true }"
      row-key="id"
      :row-selection="{ type: 'checkbox', showCheckedAll: true }"
      @selection-change="handleSelectionChange"
    >
      <template #columns>
        <a-table-column title="运行记录" :width="230">
          <template #cell="{ record }">
            <div class="primary-cell">
              <router-link :to="`/runs/${record.id}`">{{ record.name }}</router-link>
              <span>{{ record.id }} · {{ record.capturedAt.slice(5, 16).replace('T', ' ') }}</span>
            </div>
          </template>
        </a-table-column>
        <a-table-column title="页面" data-index="page" :width="130" />
        <a-table-column title="设备 / 主题" :width="170">
          <template #cell="{ record }">
            {{ record.device }}
            <div class="sub-text">{{ record.theme === 'light' ? '浅色主题' : '深色主题' }}</div>
          </template>
        </a-table-column>
        <a-table-column title="构建版本" :width="180">
          <template #cell="{ record }">
            <code>{{ record.build }}</code>
            <div class="sub-text">{{ record.baselineVersion }} → {{ record.currentVersion }}</div>
          </template>
        </a-table-column>
        <a-table-column title="差异" :width="110">
          <template #cell="{ record }">
            <b :class="{ danger: record.mismatchRate >= 5 }">{{ record.mismatchRate.toFixed(2) }}%</b>
          </template>
        </a-table-column>
        <a-table-column title="差异区域" :width="100">
          <template #cell="{ record }">{{ record.regions.length }} 处</template>
        </a-table-column>
        <a-table-column title="状态" :width="100">
          <template #cell="{ record }"><StatusTag :status="record.status" /></template>
        </a-table-column>
        <a-table-column title="操作" :width="110" fixed="right">
          <template #cell="{ record }"><router-link :to="`/runs/${record.id}`">差异定位</router-link></template>
        </a-table-column>
      </template>
    </a-table>
  </a-card>

  <a-modal
    v-model:visible="uploadVisible"
    title="执行机分片回传"
    :ok-loading="importMutation.isPending.value"
    ok-text="归档到批次并配对"
    width="720px"
    @ok="submitImport"
  >
    <a-alert type="info" style="margin-bottom: 16px">
      同项目、同构建、同页面/设备的重复分片按内容指纹只归档一次；已批准页面收到晚到分片也不会绕过现有基线。
    </a-alert>
    <a-form :model="uploadForm" layout="vertical">
      <a-grid :cols="2" :col-gap="16">
        <a-grid-item>
          <a-form-item label="项目" required>
            <a-select v-model="uploadForm.projectId" placeholder="选择所属项目">
              <a-option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</a-option>
            </a-select>
          </a-form-item>
        </a-grid-item>
        <a-grid-item>
          <a-form-item label="页面" required>
            <a-input v-model="uploadForm.page" placeholder="例如：订单结算页" />
          </a-form-item>
        </a-grid-item>
        <a-grid-item>
          <a-form-item label="设备" required>
            <a-select v-model="uploadForm.device" allow-create>
              <a-option value="Desktop 1440">Desktop 1440</a-option>
              <a-option value="Desktop 1920">Desktop 1920</a-option>
              <a-option value="iPhone 15">iPhone 15</a-option>
              <a-option value="Android Pixel 8">Android Pixel 8</a-option>
            </a-select>
          </a-form-item>
        </a-grid-item>
        <a-grid-item>
          <a-form-item label="主题" required>
            <a-radio-group v-model="uploadForm.theme" type="button">
              <a-radio value="light">浅色</a-radio>
              <a-radio value="dark">深色</a-radio>
            </a-radio-group>
          </a-form-item>
        </a-grid-item>
        <a-grid-item>
          <a-form-item label="构建版本" required>
            <a-input v-model="uploadForm.build" placeholder="release/6.18.0" />
          </a-form-item>
        </a-grid-item>
        <a-grid-item>
          <a-form-item label="执行机标识（可选）">
            <a-input v-model="uploadForm.executor" placeholder="executor-shard-2" />
          </a-form-item>
        </a-grid-item>
        <a-grid-item>
          <a-form-item label="基线版本">
            <a-input v-model="uploadForm.baselineVersion" placeholder="留空则使用当前有效基线" />
          </a-form-item>
        </a-grid-item>
        <a-grid-item>
          <a-form-item label="当前图版本">
            <a-input v-model="uploadForm.currentVersion" placeholder="留空则使用构建版本" />
          </a-form-item>
        </a-grid-item>
      </a-grid>
      <a-form-item label="截图文件" required>
        <a-upload
          v-model:file-list="uploadFiles"
          draggable
          multiple
          accept="image/png,image/jpeg,image/webp"
          :auto-upload="false"
          :limit="20"
          tip="同一批上传的文件视为执行机的多个分片；支持 PNG、JPG、WebP，总大小不超过 4MB。"
        />
      </a-form-item>
      <a-form-item label="基线图（可选）">
        <a-upload
          v-model:file-list="baselineFiles"
          draggable
          accept="image/png,image/jpeg,image/webp"
          :auto-upload="false"
          :limit="1"
          tip="上传一张基线图会配对到本批全部当前图；留空则使用当前有效基线。"
        />
      </a-form-item>
    </a-form>
  </a-modal>
</template>
