export type ReviewCategory = 'design-change' | 'render-error' | 'environment-noise'
export type RunStatus = 'pending' | 'approved' | 'rejected' | 'merged'
export type Severity = 'high' | 'medium' | 'low'

// 评审批次状态：收片中 / 评审中 / 已批准 / 已驳回 / 部分批准（晚到分片重开）
export type BatchStatus = 'collecting' | 'in-review' | 'approved' | 'rejected' | 'partially-approved'

export interface Project {
  id: string
  name: string
  code: string
  owner: string
  pageCount: number
}

export interface DifferenceRegion {
  id: string
  x: number
  y: number
  width: number
  height: number
  severity: Severity
  pixels: number
  kind: 'layout' | 'content' | 'color' | 'environment'
  ignored: boolean
  ruleId?: string
  // 区域对应的稳定 DOM 选择器，用于忽略规则匹配
  selector?: string
}

export interface ReviewRecord {
  category: ReviewCategory
  decision: 'approved' | 'rejected'
  reviewer: string
  reason: string
  reviewedAt: string
  batchId?: string
  round?: number
}

export interface ScreenshotRun {
  id: string
  name: string
  projectId: string
  page: string
  device: string
  theme: 'light' | 'dark'
  build: string
  status: RunStatus
  mismatchRate: number
  capturedAt: string
  baselineVersion: string
  currentVersion: string
  baselineImage?: string
  currentImage?: string
  regions: DifferenceRegion[]
  review?: ReviewRecord
  mergedRunIds?: string[]
  // 分片归档信息
  batchId?: string
  shardKey?: string
  executor?: string
  shardIndex?: number
  duplicated?: boolean
}

export interface Baseline {
  id: string
  projectId: string
  page: string
  device: string
  theme: 'light' | 'dark'
  version: string
  approvedBy: string
  reason: string
  approvedAt: string
  runId: string
  active: boolean
  batchId?: string
  round?: number
}

export interface IgnoreRule {
  id: string
  name: string
  projectId: string
  selector: string
  pagePattern: string
  devicePattern: string
  maxDelta: number
  enabled: boolean
  createdAt: string
}

// 进入评审时冻结的规则快照
export interface RuleSnapshot {
  id: string
  takenAt: string
  hash: string
  rules: IgnoreRule[]
}

// 区域判定：与 round 绑定，确认后锁定
export interface RegionState {
  runId: string
  regionId: string
  ignored: boolean
  ruleId?: string
  manual: boolean
  state: 'pending' | 'confirmed'
  round: number
}

export interface BatchRound {
  round: number
  snapshotId: string
  startedAt: string
  closedAt?: string
  // open=评审中；approved/rejected=本轮定论；superseded=新分片或规则变化后被新一轮接替
  status: 'open' | 'approved' | 'rejected' | 'superseded'
  runIds: string[]
}

export interface BatchApproval {
  opId: string
  round: number
  decision: 'approved' | 'rejected'
  category: ReviewCategory
  reviewer: string
  reason: string
  reviewedAt: string
  runIds: string[]
  baselineId?: string
}

export interface ReviewBatch {
  id: string
  // 批次自然键：同项目 + 同构建 + 同页面 + 同设备 + 同主题
  key: string
  projectId: string
  page: string
  device: string
  theme: 'light' | 'dark'
  build: string
  status: BatchStatus
  revision: number
  currentRound: number
  runIds: string[]
  archivedShardKeys: string[]
  snapshots: RuleSnapshot[]
  rounds: BatchRound[]
  regions: RegionState[]
  approvals: BatchApproval[]
  createdAt: string
  updatedAt: string
}

export interface BatchDraft {
  form: ReviewPayload
  savedAt: string
  attemptedRevision: number
  serverRevision: number
  conflict: string
}

export interface RegionView extends DifferenceRegion {
  state: RegionState
}

export interface BatchShardView {
  run: ScreenshotRun
  regions: RegionView[]
}

export interface BatchDetail extends ReviewBatch {
  shards: BatchShardView[]
  pendingRunIds: string[]
  draft?: BatchDraft
  rulesChanged: boolean
}

export interface RecoveryInfo {
  opId: string
  type: string
  at: string
  recoveredAt: string
}

export interface SystemState {
  fault: boolean
  recovery?: RecoveryInfo | null
}

export interface DashboardData {
  pendingReview: number
  approvedToday: number
  highRisk: number
  activeBaselines: number
  trend: Array<{ date: string; total: number; failed: number }>
}

export interface RunFilters {
  projectId?: string
  page?: string
  device?: string
  theme?: string
  build?: string
  status?: string
  keyword?: string
}

export interface ReviewPayload {
  category: ReviewCategory
  decision: 'approved' | 'rejected'
  reviewer: string
  reason: string
}

export interface ImportRunPayload {
  projectId: string
  page: string
  device: string
  theme: 'light' | 'dark'
  build: string
  baselineVersion: string
  currentVersion: string
  files: Array<{ name: string; size: number; dataUrl: string }>
  baselineImage?: string
  executor?: string
  shardBase?: number
}

export interface BatchSubmitPayload extends ReviewPayload {
  revision: number
  round: number
  opId?: string
}

export interface BatchRegionTogglePayload {
  runId: string
  regionId: string
  ignored: boolean
  revision: number
}

export interface ImportShardResult {
  runs: ScreenshotRun[]
  duplicated: number
  batchId: string
}
