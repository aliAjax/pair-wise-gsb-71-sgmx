export type ReviewCategory = 'design-change' | 'render-error' | 'environment-noise'
export type RunStatus = 'pending' | 'approved' | 'rejected' | 'merged' | 'archived'
export type Severity = 'high' | 'medium' | 'low'
export type BatchStage = 'collecting' | 'in-review' | 'completed'
export type RegionDecision = 'pending' | 'ignored' | 'confirmed'
export type DecisionSource = 'rule' | 'manual'
export type RegionKind = 'layout' | 'content' | 'color' | 'environment'

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
  kind: RegionKind
  ignored: boolean
  ruleId?: string
  /** 规则判定时匹配到的实际色差，供规则快照重算使用 */
  delta?: number
  /** 进入评审后的区域判定：待判定 / 已忽略 / 已确认 */
  decision?: RegionDecision
  /** 判定来源：规则快照自动命中，或评审员手工操作 */
  source?: DecisionSource
  /** 已确认区域固定，规则变化或新分片到达时不重算 */
  pinned?: boolean
}

export interface ReviewRecord {
  category: ReviewCategory
  decision: 'approved' | 'rejected'
  reviewer: string
  reason: string
  reviewedAt: string
  /** 幂等键：同一审批（含冲突恢复）只产生一条审批记录和一条基线 */
  idempotencyKey?: string
  /** 审批时批次版本，用于并发提交冲突检测 */
  batchVersion?: number
}

/** 进入评审时冻结的规则快照 */
export interface RuleSnapshot {
  id: string
  name: string
  selector: string
  pagePattern: string
  devicePattern: string
  maxDelta: number
  enabled: boolean
  /** 快照时的规则内容签名，用于检测规则事后是否变化 */
  signature: string
  snapshottedAt: string
}

/** 分片归档记录：同项目同一构建同一页面/设备/主题的重复分片只归档一次 */
export interface ArchivedFragment {
  runId: string
  fragmentIndex: number
  fingerprint: string
  executor: string
  receivedAt: string
  regionCount: number
}

export interface BatchItem {
  id: string
  page: string
  device: string
  theme: 'light' | 'dark'
  primaryRunId: string
  fragmentRunIds: string[]
  archivedFragments: ArchivedFragment[]
  regions: DifferenceRegion[]
  status: Extract<RunStatus, 'pending' | 'approved' | 'rejected'>
  review?: ReviewRecord
  /** 批准时依据的旧基线 id（保留可追溯，不覆盖） */
  previousBaselineId?: string
  /** 批准生成的新基线 id */
  baselineId?: string
  mismatchRate: number
  updatedAt: string
}

export interface ReviewBatch {
  id: string
  projectId: string
  build: string
  name: string
  stage: BatchStage
  version: number
  ruleSnapshotId: string
  ruleSnapshots: RuleSnapshot[]
  items: BatchItem[]
  createdAt: string
  updatedAt: string
  /** 进入评审的时间，同时是区域判定固定时间 */
  reviewStartedAt?: string
  completedAt?: string
}

/** 并发提交失败后留下的草稿（后到窗口的表单完整保留） */
export interface BatchDraft {
  id: string
  batchId: string
  itemId: string
  expectedVersion: number
  payload: ReviewPayload
  createdAt: string
  reason: string
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
  batchId?: string
  itemId?: string
  /** 是否为被归档的重复分片 */
  fragmentOfRunId?: string
  fragmentIndex?: number
  fingerprint?: string
  executor?: string
  receivedAt?: string
}

export interface Baseline {
  id: string
  projectId: string
  page: string
  pageName?: string
  device: string
  theme: 'light' | 'dark'
  version: string
  approvedBy: string
  reason: string
  approvedAt: string
  runId: string
  batchId?: string
  itemId?: string
  /** 批准时被替换停用的上一版本基线 id，保留旧基线依据 */
  previousBaselineId?: string
  /** 产生该基线的审批幂等键 */
  idempotencyKey?: string
  active: boolean
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
  updatedAt?: string
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
  /** 是否排除被归档的重复分片，默认 true */
  includeFragments?: boolean
}

export interface ReviewPayload {
  category: ReviewCategory
  decision: 'approved' | 'rejected'
  reviewer: string
  reason: string
  /** 乐观锁：提交时基于的批次版本 */
  expectedVersion?: number
  /** 幂等键，防止重复审批记录 */
  idempotencyKey?: string
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
  /** 执行机标识，模拟分批回传来源 */
  executor?: string
  /** 分片序号 */
  fragmentIndex?: number
  /** 分片内容指纹，服务端会按项目+构建+页面维度再次去重 */
  fingerprint?: string
}

/** 保存区域判定的载荷 */
export interface RegionDecisionPayload {
  regionId: string
  decision: Exclude<RegionDecision, 'pending'>
  expectedVersion?: number
}

/** 开始评审的返回 */
export interface StartReviewResult {
  batch: ReviewBatch
  /** 是否为首次进入评审（本次完成了快照固定） */
  started: boolean
}

export interface RecomputeResult {
  batch: ReviewBatch
  /** 本次重算中保持固定的已确认/已批准区域数 */
  pinnedCount: number
  /** 实际重算的未批准区域数 */
  recomputedCount: number
}

export interface DraftListResponse {
  drafts: BatchDraft[]
}
