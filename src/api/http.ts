import axios, {
  AxiosError,
  type AxiosAdapter,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios'
import {
  commitDb,
  consumeRecoveryInfo,
  isFaultEnabled,
  readDb,
  setFaultEnabled,
  StorageWriteError,
  type Database,
} from '@/mocks/db'
import {
  batchKeyOf,
  evaluateRegions,
  hashRules,
  shardKeyOf,
} from '@/mocks/batch'
import type {
  Baseline,
  BatchDetail,
  BatchDraft,
  BatchRegionTogglePayload,
  BatchShardView,
  BatchSubmitPayload,
  DashboardData,
  DifferenceRegion,
  IgnoreRule,
  ImportRunPayload,
  ImportShardResult,
  Project,
  RegionState,
  ReviewBatch,
  ReviewPayload,
  RunFilters,
  ScreenshotRun,
} from '@/types'

export const api = axios.create({
  baseURL: '/mock-api',
  timeout: 8000,
  headers: { 'Content-Type': 'application/json' },
})

const respond = <T>(config: InternalAxiosRequestConfig, data: T, status = 200): AxiosResponse<T> => ({
  data,
  status,
  statusText: status === 200 ? 'OK' : status === 201 ? 'Created' : status === 409 ? 'Conflict' : 'Error',
  headers: {},
  config,
})

const fail = (
  config: InternalAxiosRequestConfig,
  status: number,
  message: string,
  extra?: Record<string, unknown>,
): never => {
  const error = new AxiosError(message, String(status), config, null, {
    data: { message, ...extra },
    status,
    statusText: message,
    headers: {},
    config,
  })
  throw error
}

const parseBody = <T>(config: InternalAxiosRequestConfig): T => {
  if (typeof config.data === 'string') return JSON.parse(config.data) as T
  return config.data as T
}

const newId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

// ---------------- 批次领域辅助 ----------------

const openRoundOf = (batch: ReviewBatch) => batch.rounds.find((round) => round.status === 'open')

const makeSnapshot = (rules: IgnoreRule[]) => {
  const takenAt = new Date().toISOString()
  return {
    id: `snap-${hashRules(rules)}-${takenAt}`,
    takenAt,
    hash: hashRules(rules),
    rules: rules.map((rule) => ({ ...rule })),
  }
}

const batchStatusOf = (batch: ReviewBatch): ReviewBatch['status'] => {
  const latest = [...batch.rounds].sort((a, b) => b.round - a.round)[0]
  if (!latest) return batch.status === 'in-review' ? 'in-review' : 'collecting'
  if (latest.status === 'open') {
    return batch.approvals.some((item) => item.decision === 'approved')
      ? 'partially-approved'
      : 'in-review'
  }
  if (latest.status === 'approved') {
    return batch.rounds.some((round, index) => index < batch.rounds.length - 1 && round.closedAt)
      ? 'partially-approved'
      : 'approved'
  }
  return 'rejected'
}

/**
 * 旧运行（批次概念上线前）首次打开：补成单运行批次。
 * 已有审批定论的运行直接还原为「已关闭的历史轮次 + 审批留痕」，
 * 不重新进入评审、不重复创建基线；旧基线依据继续保留。
 */
const migrateLegacyRun = (db: Database, run: ScreenshotRun): ReviewBatch => {
  const now = new Date().toISOString()
  const batch: ReviewBatch = {
    id: newId('batch'),
    key: batchKeyOf(run),
    projectId: run.projectId,
    page: run.page,
    device: run.device,
    theme: run.theme,
    build: run.build,
    status: 'collecting',
    revision: 1,
    currentRound: 0,
    runIds: [run.id],
    archivedShardKeys: [run.shardKey ?? shardKeyOf(run)],
    snapshots: [],
    rounds: [],
    regions: [],
    approvals: [],
    createdAt: now,
    updatedAt: now,
  }
  run.batchId = batch.id
  if (!run.shardKey) run.shardKey = shardKeyOf(run)
  db.batches.unshift(batch)

  if (run.review) {
    const snapshot = makeSnapshot(db.rules)
    batch.snapshots.push(snapshot)
    batch.currentRound = 1
    batch.rounds.push({
      round: 1,
      snapshotId: snapshot.id,
      startedAt: run.review.reviewedAt,
      closedAt: run.review.reviewedAt,
      status: run.review.decision,
      runIds: [run.id],
    })
    batch.regions = run.regions.map((region) => ({
      runId: run.id,
      regionId: region.id,
      ignored: region.ignored,
      ruleId: region.ruleId,
      manual: false,
      state: 'confirmed',
      round: 1,
    }))
    const historicalBaseline = db.baselines.find(
      (baseline) =>
        baseline.runId === run.id ||
        (baseline.active &&
          baseline.projectId === run.projectId &&
          baseline.page === run.page &&
          baseline.device === run.device &&
          baseline.theme === run.theme),
    )
    batch.approvals.push({
      opId: `legacy-${run.id}`,
      round: 1,
      decision: run.review.decision,
      category: run.review.category,
      reviewer: run.review.reviewer,
      reason: run.review.reason,
      reviewedAt: run.review.reviewedAt,
      runIds: [run.id],
      baselineId: run.review.decision === 'approved' ? historicalBaseline?.id : undefined,
    })
    batch.status = run.review.decision === 'approved' ? 'approved' : 'rejected'
  }
  return batch
}

const createBatchForRuns = (
  db: Database,
  runs: ScreenshotRun[],
  persist: (next: Database, opId: string, note: string) => void,
): ReviewBatch => {
  const first = runs[0]
  const now = new Date().toISOString()
  const batch: ReviewBatch = {
    id: newId('batch'),
    key: batchKeyOf(first),
    projectId: first.projectId,
    page: first.page,
    device: first.device,
    theme: first.theme,
    build: first.build,
    status: 'collecting',
    revision: 1,
    currentRound: 0,
    runIds: [],
    archivedShardKeys: [],
    snapshots: [],
    rounds: [],
    regions: [],
    approvals: [],
    createdAt: now,
    updatedAt: now,
  }
  for (const run of runs) attachRunToBatch(db, batch, run)
  db.batches.unshift(batch)
  persist(db, newId('op-batch'), '创建评审批次')
  return batch
}

/**
 * 归档分片到批次：
 * - 同批次相同 shardKey 只归档一次，重复分片标记 duplicated
 * - 已在评审中的批次收到新分片：只重算未确认区域，已确认区域/审批/旧基线保留
 */
const attachRunToBatch = (db: Database, batch: ReviewBatch, run: ScreenshotRun): boolean => {
  const shardKey = run.shardKey ?? shardKeyOf(run)
  run.shardKey = shardKey
  run.batchId = batch.id

  const duplicate = batch.archivedShardKeys.includes(shardKey)
  if (duplicate) {
    run.duplicated = true
    return false
  }

  batch.archivedShardKeys.push(shardKey)
  if (!batch.runIds.includes(run.id)) batch.runIds.push(run.id)

  if (batch.currentRound > 0) {
    // 晚到分片（含已批准/已驳回批次）：冻结旧轮次并开新一轮，只重算未确认区域；
    // 已确认区域、审批记录与旧基线原样保留
    const active = openRoundOf(batch)
    const anchor = active ?? [...batch.rounds].sort((a, b) => b.round - a.round)[0]
    const anchorSnapshot =
      batch.snapshots.find((item) => item.id === anchor?.snapshotId) ?? batch.snapshots[0]
    const rules = anchorSnapshot ? anchorSnapshot.rules : db.rules
    if (active) active.status = 'superseded'
    batch.currentRound += 1
    const snapshot = makeSnapshot(rules)
    batch.snapshots.push(snapshot)
    batch.rounds.push({
      round: batch.currentRound,
      snapshotId: snapshot.id,
      startedAt: new Date().toISOString(),
      status: 'open',
      runIds: [...batch.runIds],
    })
    batch.regions = evaluateRegions(batch.regions, collectBatchRuns(db, batch), rules, batch.currentRound)
    batch.status = batch.approvals.length > 0 ? 'partially-approved' : 'in-review'
  }
  return true
}

const collectBatchRuns = (db: Database, batch: ReviewBatch): ScreenshotRun[] =>
  batch.runIds
    .map((id) => db.runs.find((run) => run.id === id))
    .filter((run): run is ScreenshotRun => Boolean(run))

/** 进入评审：固定规则快照 + 区域判定（幂等，重复进入不产生新轮次） */
const enterReview = (db: Database, batch: ReviewBatch): void => {
  if (openRoundOf(batch)) return
  const snapshot = makeSnapshot(db.rules)
  batch.snapshots.push(snapshot)
  batch.currentRound += 1
  batch.rounds.push({
    round: batch.currentRound,
    snapshotId: snapshot.id,
    startedAt: new Date().toISOString(),
    status: 'open',
    runIds: [...batch.runIds],
  })
  const runs = collectBatchRuns(db, batch)
  batch.regions = evaluateRegions(batch.regions, runs, db.rules, batch.currentRound)
  batch.status = batch.approvals.length > 0 ? 'partially-approved' : 'in-review'
}

/** 规则变化：只重算未确认区域，确认状态原样保留；规则未变则不开新轮次 */
const recomputeOpenRound = (db: Database, batch: ReviewBatch): boolean => {
  const active = openRoundOf(batch)
  if (!active) return false
  const activeSnapshot = batch.snapshots.find((item) => item.id === active.snapshotId)
  if (activeSnapshot && activeSnapshot.hash === hashRules(db.rules)) return false
  batch.rounds.forEach((round) => {
    if (round.status === 'open') round.status = 'superseded'
  })
  const snapshot = makeSnapshot(db.rules)
  batch.snapshots.push(snapshot)
  batch.currentRound += 1
  batch.rounds.push({
    round: batch.currentRound,
    snapshotId: snapshot.id,
    startedAt: new Date().toISOString(),
    status: 'open',
    runIds: [...batch.runIds],
  })
  batch.regions = evaluateRegions(
    batch.regions,
    collectBatchRuns(db, batch),
    db.rules,
    batch.currentRound,
  )
  return true
}

const assembleBatchDetail = (
  db: Database,
  batch: ReviewBatch,
  includeDraft: boolean,
): BatchDetail => {
  const runs = collectBatchRuns(db, batch)
  const active = openRoundOf(batch)
  const activeRulesHash = active
    ? batch.snapshots.find((item) => item.id === active.snapshotId)?.hash
    : undefined
  const rulesChanged = Boolean(active && activeRulesHash && hashRules(db.rules) !== activeRulesHash)

  const pendingRunIds = active
    ? runs
        .filter((run) => !batch.approvals.some((approval) => approval.runIds.includes(run.id)))
        .map((run) => run.id)
    : []

  const shards: BatchShardView[] = runs.map((run) => {
    const regions = run.regions.map((region) => {
      // 每个区域取其最新一轮的判定；前端据此区分已锁定（历史轮次）与当前可改
      const state =
        batch.regions
          .filter((item) => item.runId === run.id && item.regionId === region.id)
          .sort((a, b) => b.round - a.round)[0] ??
        ({
          runId: run.id,
          regionId: region.id,
          ignored: region.ignored,
          ruleId: region.ruleId,
          manual: false,
          state: 'pending',
          round: 0,
        } satisfies RegionState)
      return { ...region, state }
    })
    return { run, regions }
  })

  const draft = includeDraft ? db.drafts[batch.id] : undefined
  return {
    ...structuredClone(batch),
    shards,
    pendingRunIds,
    draft,
    rulesChanged,
  }
}

const persistDraft = (
  db: Database,
  batchId: string,
  form: ReviewPayload,
  attemptedRevision: number,
  serverRevision: number,
  conflict: string,
  persist: (next: Database, opId: string, note: string) => void,
): void => {
  const draft: BatchDraft = {
    form: { ...form },
    savedAt: new Date().toISOString(),
    attemptedRevision,
    serverRevision,
    conflict,
  }
  db.drafts[batchId] = draft
  persist(db, newId('op-draft'), '保存冲突草稿')
}

// ---------------- Mock Adapter ----------------

const mockAdapter: AxiosAdapter = async (config) => {
  await new Promise((resolve) => window.setTimeout(resolve, 160))
  const db = readDb()
  const method = (config.method ?? 'get').toLowerCase()
  const path = config.url ?? ''

  // 所有写操作在克隆上进行，commit 失败（WAL 已留痕）时不污染内存快照
  const commit = (next: Database, opId: string, note: string) => commitDb(next, opId, note)

  if (method === 'get' && path === '/projects') {
    return respond<Project[]>(config, db.projects)
  }

  if (method === 'get' && path === '/dashboard') {
    const canonicalRuns = db.runs.filter((run) => !run.duplicated)
    const dashboard: DashboardData = {
      pendingReview: canonicalRuns.filter((run) => run.status === 'pending').length,
      approvedToday: canonicalRuns.filter(
        (run) =>
          run.review?.decision === 'approved' && run.review.reviewedAt.startsWith('2026-09-29'),
      ).length,
      highRisk: canonicalRuns.filter((run) => run.mismatchRate >= 5 && run.status !== 'merged').length,
      activeBaselines: db.baselines.filter((baseline) => baseline.active).length,
      trend: [
        { date: '09-23', total: 36, failed: 7 },
        { date: '09-24', total: 42, failed: 4 },
        { date: '09-25', total: 39, failed: 9 },
        { date: '09-26', total: 47, failed: 6 },
        { date: '09-27', total: 44, failed: 5 },
        { date: '09-28', total: 52, failed: 11 },
        { date: '09-29', total: 29, failed: 8 },
      ],
    }
    return respond(config, dashboard)
  }

  if (method === 'get' && path === '/runs') {
    const filters = (config.params ?? {}) as RunFilters
    const keyword = filters.keyword?.trim().toLowerCase()
    const includeDuplicated = config.params?.includeDuplicated === true
    const data = db.runs
      .filter((run) => includeDuplicated || !run.duplicated)
      .filter((run) => {
        return (
          (!filters.projectId || run.projectId === filters.projectId) &&
          (!filters.page || run.page === filters.page) &&
          (!filters.device || run.device === filters.device) &&
          (!filters.theme || run.theme === filters.theme) &&
          (!filters.build || run.build === filters.build) &&
          (!filters.status || run.status === filters.status) &&
          (!keyword ||
            run.name.toLowerCase().includes(keyword) ||
            run.page.toLowerCase().includes(keyword) ||
            run.id.toLowerCase().includes(keyword))
        )
      })
    return respond(config, data)
  }

  const runMatch = path.match(/^\/runs\/([^/]+)$/)
  if (method === 'get' && runMatch) {
    const run = db.runs.find((item) => item.id === runMatch[1])
    if (!run) fail(config, 404, '运行记录不存在')
    return respond(config, run!)
  }

  // 进入评审：旧运行首次打开时在此补成单运行批次，并固定规则快照 + 区域判定
  const enterMatch = path.match(/^\/runs\/([^/]+)\/enter-review$/)
  if (method === 'post' && enterMatch) {
    const next = structuredClone(db)
    const nextRun =
      next.runs.find((item) => item.id === enterMatch[1]) ??
      fail(config, 404, '运行记录不存在')
    let batch = next.batches.find((item) => item.id === nextRun.batchId)
    if (!batch) {
      if (nextRun.review) {
        // 旧的已定论运行：补成带历史轮次的单运行批次，不重开评审
        batch = migrateLegacyRun(next, nextRun)
        commit(next, newId('op-migrate'), '旧运行补建单运行批次')
        return respond(config, assembleBatchDetail(next, batch, true), 201)
      }
      batch = createBatchForRuns(next, [nextRun], commit)
    }
    enterReview(next, batch)
    batch.revision += 1
    batch.updatedAt = new Date().toISOString()
    commit(next, newId('op-enter'), '进入评审并冻结规则快照')
    return respond(config, assembleBatchDetail(next, batch, true), 201)
  }

  // 兼容旧的单运行审批入口：委托给所属批次
  const legacyReviewMatch = path.match(/^\/runs\/([^/]+)\/review$/)
  if (method === 'patch' && legacyReviewMatch) {
    const payload = parseBody<ReviewPayload>(config)
    const next = structuredClone(db)
    const nextRun =
      next.runs.find((item) => item.id === legacyReviewMatch[1]) ??
      fail(config, 404, '运行记录不存在')
    let batch = next.batches.find((item) => item.id === nextRun.batchId)
    if (!batch) {
      if (nextRun.review) batch = migrateLegacyRun(next, nextRun)
      else batch = createBatchForRuns(next, [nextRun], commit)
    }
    if (!openRoundOf(batch)) {
      fail(config, 409, '该运行已有审批定论，新分片到达后请在新一轮中评审')
    }
    enterReview(next, batch)
    const active = openRoundOf(batch)!
    const submitPayload: BatchSubmitPayload = { ...payload, revision: batch.revision, round: active.round }
    return submitBatch(config, next, batch, submitPayload)
  }

  if (method === 'post' && path === '/runs/merge') {
    const ids = parseBody<string[]>(config)
    const next = structuredClone(db)
    const selected = next.runs.filter((run) => ids.includes(run.id) && !run.duplicated)
    if (selected.length < 2) fail(config, 400, '至少选择两条运行记录进行合并')
    const [first, ...rest] = selected
    first.mergedRunIds = selected.map((run) => run.id)
    first.status = 'merged'
    first.mismatchRate =
      selected.reduce((sum, run) => sum + run.mismatchRate, 0) / Math.max(selected.length, 1)
    first.regions = rest.flatMap((run) => run.regions).slice(0, 8)
    commit(next, newId('op-merge'), '合并重复运行')
    return respond(config, first, 201)
  }

  if (method === 'post' && path === '/runs/import') {
    const payload = parseBody<ImportRunPayload>(config)
    if (
      !payload.projectId ||
      !payload.page.trim() ||
      !payload.device.trim() ||
      !payload.build.trim() ||
      payload.files.length === 0
    ) {
      fail(config, 400, '项目、页面、设备、构建版本和截图文件不能为空')
    }
    const next = structuredClone(db)
    const executor = payload.executor?.trim() || `executor-${Math.floor(Math.random() * 900 + 100)}`
    const shardBase = payload.shardBase ?? 0
    const imported: ScreenshotRun[] = []
    let duplicated = 0
    let batchId = ''

    payload.files.forEach((file, index) => {
      const shardIndex = shardBase + index
      const runId = newId('run')
      const mismatchRate = Number((0.8 + ((file.name.length + index * 3) % 58) / 10).toFixed(2))
      const severity = mismatchRate >= 5 ? 'high' : mismatchRate >= 2 ? 'medium' : 'low'
      const regions: DifferenceRegion[] = [
        {
          id: `${runId}-r1`,
          x: 12 + index * 3,
          y: 22 + index * 2,
          width: 24,
          height: 14,
          severity,
          pixels: Math.round(file.size / 8 || 620),
          kind: 'layout',
          ignored: false,
        },
        {
          id: `${runId}-r2`,
          x: 58,
          y: 52,
          width: 16,
          height: 10,
          severity: severity === 'high' ? 'medium' : 'low',
          pixels: Math.round(file.size / 18 || 180),
          kind: 'color',
          ignored: false,
        },
      ]
      const run: ScreenshotRun = {
        id: runId,
        name: `${payload.page.trim()} ${payload.device.trim()}回归`,
        projectId: payload.projectId,
        page: payload.page.trim(),
        device: payload.device.trim(),
        theme: payload.theme,
        build: payload.build.trim(),
        status: 'pending',
        mismatchRate,
        capturedAt: new Date().toISOString(),
        baselineVersion: payload.baselineVersion.trim() || '当前有效基线',
        currentVersion: payload.currentVersion.trim() || payload.build.trim(),
        baselineImage: payload.baselineImage,
        currentImage: file.dataUrl,
        regions,
        executor,
        shardIndex,
      }
      next.runs.unshift(run)

      const key = batchKeyOf(run)
      let batch = next.batches.find((item) => item.key === key)
      if (!batch) {
        batch = {
          id: newId('batch'),
          key,
          projectId: run.projectId,
          page: run.page,
          device: run.device,
          theme: run.theme,
          build: run.build,
          status: 'collecting',
          revision: 1,
          currentRound: 0,
          runIds: [],
          archivedShardKeys: [],
          snapshots: [],
          rounds: [],
          regions: [],
          approvals: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
        next.batches.unshift(batch)
      }
      batchId = batch.id
      const archived = attachRunToBatch(next, batch, run)
      if (archived) {
        batch.revision += 1
        batch.updatedAt = run.capturedAt
      } else {
        duplicated += 1
      }
      imported.push(run)
    })

    commit(next, newId('op-import'), '归档回归分片')
    const result: ImportShardResult = { runs: imported, duplicated, batchId }
    return respond(config, result, 201)
  }

  if (method === 'get' && path === '/baselines') {
    const projectId = config.params?.projectId as string | undefined
    return respond(
      config,
      db.baselines.filter((baseline) => !projectId || baseline.projectId === projectId),
    )
  }

  if (method === 'get' && path === '/rules') {
    return respond<IgnoreRule[]>(config, db.rules)
  }

  if (method === 'post' && path === '/rules') {
    const input = parseBody<Omit<IgnoreRule, 'id' | 'createdAt'>>(config)
    const next = structuredClone(db)
    const rule: IgnoreRule = {
      ...input,
      id: newId('rule'),
      createdAt: new Date().toISOString(),
    }
    next.rules.unshift(rule)
    // 规则变化不自动改动评审中批次：快照保持固定，批次详情会标记 rulesChanged，
    // 由评审员显式触发「只重算未确认区域」
    commit(next, newId('op-rule'), '新建忽略规则')
    return respond(config, rule, 201)
  }

  const ruleMatch = path.match(/^\/rules\/([^/]+)$/)
  if (method === 'patch' && ruleMatch) {
    const payload = parseBody<Partial<IgnoreRule>>(config)
    const next = structuredClone(db)
    const foundRule = next.rules.find((item) => item.id === ruleMatch[1])
    if (!foundRule) fail(config, 404, '规则不存在')
    const rule = foundRule!
    Object.assign(rule, payload)
    commit(next, newId('op-rule'), '更新忽略规则')
    return respond(config, rule)
  }
  if (method === 'delete' && ruleMatch) {
    const next = structuredClone(db)
    const index = next.rules.findIndex((item) => item.id === ruleMatch[1])
    if (index < 0) fail(config, 404, '规则不存在')
    next.rules.splice(index, 1)
    commit(next, newId('op-rule'), '删除忽略规则')
    return respond(config, { success: true })
  }

  // ---------------- 批次接口 ----------------

  if (method === 'get' && path === '/batches') {
    const projectId = config.params?.projectId as string | undefined
    const list = db.batches
      .filter((batch) => !projectId || batch.projectId === projectId)
      .map((batch) => ({
        ...batch,
        runCount: batch.runIds.length,
        pendingCount: collectBatchRuns(db, batch).filter((run) => run.status === 'pending').length,
        maxMismatch: Math.max(
          0,
          ...collectBatchRuns(db, batch).map((run) => run.mismatchRate),
        ),
      }))
    return respond(config, list)
  }

  const batchMatch = path.match(/^\/batches\/([^/]+)$/)
  if (method === 'get' && batchMatch) {
    const batch = db.batches.find((item) => item.id === batchMatch[1])
    if (!batch) fail(config, 404, '评审批次不存在')
    return respond(config, assembleBatchDetail(db, batch!, true))
  }

  const recomputeMatch = path.match(/^\/batches\/([^/]+)\/recompute$/)
  if (method === 'post' && recomputeMatch) {
    const body = parseBody<{ revision: number }>(config)
    const next = structuredClone(db)
    const batch = next.batches.find((item) => item.id === recomputeMatch[1])
    if (!batch) fail(config, 404, '评审批次不存在')
    if (body.revision !== batch!.revision) {
      fail(config, 409, '批次已被其他窗口更新，已为你保留当前判定，请刷新后重试', {
        serverRevision: batch!.revision,
      })
    }
    const changed = recomputeOpenRound(next, batch!)
    if (changed) {
      batch!.revision += 1
      batch!.updatedAt = new Date().toISOString()
      commit(next, newId('op-recompute'), '规则变化增量重算')
    }
    return respond(config, assembleBatchDetail(next, batch!, true))
  }

  const regionMatch = path.match(/^\/batches\/([^/]+)\/regions$/)
  if (method === 'patch' && regionMatch) {
    const payload = parseBody<BatchRegionTogglePayload>(config)
    const next = structuredClone(db)
    const target = next.batches.find((item) => item.id === regionMatch[1])
    if (!target) fail(config, 404, '评审批次不存在')
    const batch = target!
    if (payload.revision !== batch.revision) {
      fail(config, 409, '批次已被其他窗口更新，区域修改未保存，请刷新后重试', {
        serverRevision: batch.revision,
      })
    }
    const active =
      openRoundOf(batch) ?? fail(config, 409, '批次不在评审中，无法修改区域')
    const locked = batch.approvals.some(
      (approval) => approval.round < active.round && approval.runIds.includes(payload.runId),
    )
    if (locked) {
      fail(config, 409, '该分片属于已批准轮次，区域已锁定，新差异请在当前轮次评审')
    }
    const state =
      batch.regions.find(
        (item) => item.runId === payload.runId && item.regionId === payload.regionId,
      ) ?? fail(config, 404, '差异区域不存在')
    state.ignored = payload.ignored
    state.manual = true
    state.ruleId = payload.ignored ? state.ruleId : undefined
    state.state = 'confirmed'
    state.round = active.round
    batch.revision += 1
    batch.updatedAt = new Date().toISOString()
    commit(next, newId('op-region'), '确认差异区域判定')
    return respond(config, assembleBatchDetail(next, batch, true))
  }

  const draftMatch = path.match(/^\/batches\/([^/]+)\/draft$/)
  if (method === 'delete' && draftMatch) {
    const next = structuredClone(db)
    delete next.drafts[draftMatch[1]]
    commit(next, newId('op-draft-clear'), '丢弃冲突草稿')
    return respond(config, { success: true })
  }

  const submitMatch = path.match(/^\/batches\/([^/]+)\/submit$/)
  if (method === 'post' && submitMatch) {
    const payload = parseBody<BatchSubmitPayload>(config)
    const next = structuredClone(db)
    const batch = next.batches.find((item) => item.id === submitMatch[1])
    if (!batch) fail(config, 404, '评审批次不存在')
    return submitBatch(config, next, batch!, payload)
  }

  if (method === 'get' && path === '/system/state') {
    const recovery = consumeRecoveryInfo()
    return respond(config, {
      fault: isFaultEnabled(),
      recovery: recovery
        ? {
            opId: recovery.opId,
            type: recovery.note,
            at: recovery.at,
            recoveredAt: recovery.recoveredAt,
          }
        : null,
    })
  }

  if (method === 'post' && path === '/system/fault') {
    const body = parseBody<{ enabled: boolean }>(config)
    setFaultEnabled(body.enabled)
    return respond(config, { fault: body.enabled })
  }

  throw new Error(`Mock API 未实现：${method.toUpperCase()} ${path}`)
}

// 批次提交：乐观锁 + 幂等 opId；冲突时保存草稿
const submitBatch = (
  config: InternalAxiosRequestConfig,
  next: Database,
  batch: ReviewBatch,
  payload: BatchSubmitPayload,
): AxiosResponse => {
  // 乐观锁优先：两个窗口同时提交同一轮时，无论轮次是否已被对方关闭，
  // 后到的保存都必须失败并留下草稿
  if (payload.revision !== batch.revision) {
    const conflict =
      batch.rounds.some((round) => round.round > payload.round) || !openRoundOf(batch)
        ? '评审期间有新分片到达或批次已被其他窗口提交，已为你保存草稿，请刷新核对新差异'
        : '批次已被其他评审窗口提交，后到的提交已保存为草稿，请刷新核对'
    try {
      persistDraft(next, batch.id, payload, payload.revision, batch.revision, conflict, commitDb)
    } catch (error) {
      if (error instanceof StorageWriteError) throw error
    }
    fail(config, 409, conflict, { serverRevision: batch.revision, draft: next.drafts[batch.id] })
  }

  const active = openRoundOf(batch) ?? fail(config, 409, '批次当前没有进行中的评审轮次')
  if (payload.round !== active.round) {
    const draftConflict = '评审期间有新分片到达，已开启新一轮，请核对新差异后重新提交'
    try {
      persistDraft(next, batch.id, payload, payload.revision, batch.revision, draftConflict, commitDb)
    } catch (error) {
      if (error instanceof StorageWriteError) throw error
    }
    fail(config, 409, draftConflict, {
      serverRevision: batch.revision,
      draft: next.drafts[batch.id],
    })
  }
  if (!payload.reviewer.trim() || !payload.reason.trim()) {
    fail(config, 400, '批准人和审批原因不能为空')
  }

  // 幂等：相同 opId 的重试直接返回，避免重复审批/重复区域
  const opId = payload.opId ?? `op-submit-${batch.id}-r${active.round}`
  const existing = batch.approvals.find((item) => item.opId === opId)
  if (existing) {
    return respond(config, assembleBatchDetail(next, batch, false))
  }

  const now = new Date().toISOString()
  const pendingRuns = collectBatchRuns(next, batch).filter(
    (run) => !batch.approvals.some((approval) => approval.runIds.includes(run.id)),
  )

  // 当前轮次的区域判定全部固定
  batch.regions = batch.regions.map((state) =>
    state.round === active.round ? { ...state, state: 'confirmed' as const } : state,
  )

  let baselineId: string | undefined
  if (payload.decision === 'approved') {
    // 旧基线依据保留：仅停用，不删除，仍可追溯
    const scopeRuns = pendingRuns
    next.baselines.forEach((baseline) => {
      if (
        baseline.active &&
        scopeRuns.some(
          (run) =>
            run.projectId === baseline.projectId &&
            run.page === baseline.page &&
            run.device === baseline.device &&
            run.theme === baseline.theme,
        )
      ) {
        baseline.active = false
      }
    })
    const baseline: Baseline = {
      id: newId('base'),
      projectId: batch.projectId,
      page: batch.page,
      device: batch.device,
      theme: batch.theme,
      version: scopeRuns[0]?.currentVersion ?? `baseline-${active.round}`,
      approvedBy: payload.reviewer,
      reason: payload.reason,
      approvedAt: now,
      runId: scopeRuns[0]?.id ?? batch.runIds[0],
      active: true,
      batchId: batch.id,
      round: active.round,
    }
    next.baselines.unshift(baseline)
    baselineId = baseline.id
  }

  for (const run of pendingRuns) {
    run.status = payload.decision
    run.review = {
      category: payload.category,
      decision: payload.decision,
      reviewer: payload.reviewer,
      reason: payload.reason,
      reviewedAt: now,
      batchId: batch.id,
      round: active.round,
    }
  }

  active.status = payload.decision
  active.closedAt = now
  batch.approvals.push({
    opId,
    round: active.round,
    decision: payload.decision,
    category: payload.category,
    reviewer: payload.reviewer,
    reason: payload.reason,
    reviewedAt: now,
    runIds: pendingRuns.map((run) => run.id),
    baselineId,
  })
  delete next.drafts[batch.id]
  batch.status = batchStatusOf(batch)
  batch.revision += 1
  batch.updatedAt = now

  try {
    commitDb(next, opId, payload.decision === 'approved' ? '批次批准并创建基线' : '批次驳回')
  } catch (error) {
    if (error instanceof StorageWriteError) {
      fail(config, 503, '本地存储写入失败，操作已进入预写日志，重启后自动恢复，请勿重复提交', {
        opId,
        recoverable: true,
      })
    }
    throw error
  }
  return respond(config, assembleBatchDetail(next, batch, false))
}

api.defaults.adapter = mockAdapter

// ---------------- API 导出 ----------------

export const getProjects = async (): Promise<Project[]> => (await api.get<Project[]>('/projects')).data
export const getDashboard = async (): Promise<DashboardData> =>
  (await api.get<DashboardData>('/dashboard')).data
export const getRuns = async (filters: RunFilters = {}): Promise<ScreenshotRun[]> =>
  (await api.get<ScreenshotRun[]>('/runs', { params: filters })).data
export const getRun = async (id: string): Promise<ScreenshotRun> =>
  (await api.get<ScreenshotRun>(`/runs/${id}`)).data
export const reviewRun = async (id: string, payload: ReviewPayload): Promise<ScreenshotRun> =>
  (await api.patch<ScreenshotRun>(`/runs/${id}/review`, payload)).data
export const mergeRuns = async (ids: string[]): Promise<ScreenshotRun> =>
  (await api.post<ScreenshotRun>('/runs/merge', ids)).data
export const importRuns = async (payload: ImportRunPayload): Promise<ImportShardResult> =>
  (await api.post<ImportShardResult>('/runs/import', payload)).data
export const getBaselines = async (projectId?: string): Promise<Baseline[]> =>
  (await api.get<Baseline[]>('/baselines', { params: { projectId } })).data
export const getRules = async (): Promise<IgnoreRule[]> =>
  (await api.get<IgnoreRule[]>('/rules')).data
export const createRule = async (
  payload: Omit<IgnoreRule, 'id' | 'createdAt'>,
): Promise<IgnoreRule> => (await api.post<IgnoreRule>('/rules', payload)).data
export const toggleRule = async (id: string, enabled: boolean): Promise<IgnoreRule> =>
  (await api.patch<IgnoreRule>(`/rules/${id}`, { enabled })).data
export const deleteRule = async (id: string): Promise<{ success: boolean }> =>
  (await api.delete<{ success: boolean }>(`/rules/${id}`)).data

// 批次 API
export type BatchSummary = ReviewBatch & {
  runCount: number
  pendingCount: number
  maxMismatch: number
}
export const getBatches = async (projectId?: string): Promise<BatchSummary[]> =>
  (await api.get<BatchSummary[]>('/batches', { params: { projectId } })).data
export const getBatch = async (id: string): Promise<BatchDetail> =>
  (await api.get<BatchDetail>(`/batches/${id}`)).data
export const enterRunReview = async (runId: string): Promise<BatchDetail> =>
  (await api.post<BatchDetail>(`/runs/${runId}/enter-review`)).data
export const recomputeBatch = async (id: string, revision: number): Promise<BatchDetail> =>
  (await api.post<BatchDetail>(`/batches/${id}/recompute`, { revision })).data
export const toggleBatchRegion = async (
  id: string,
  payload: BatchRegionTogglePayload,
): Promise<BatchDetail> =>
  (await api.patch<BatchDetail>(`/batches/${id}/regions`, payload)).data
export const submitBatchReview = async (
  id: string,
  payload: BatchSubmitPayload,
): Promise<BatchDetail> => (await api.post<BatchDetail>(`/batches/${id}/submit`, payload)).data
export const discardDraft = async (id: string): Promise<{ success: boolean }> =>
  (await api.delete<{ success: boolean }>(`/batches/${id}/draft`)).data
export const getSystemState = async () =>
  (
    await api.get<{
      fault: boolean
      recovery: { opId: string; type: string; at: string; recoveredAt: string } | null
    }>('/system/state')
  ).data
export const setFault = async (enabled: boolean) =>
  (await api.post<{ fault: boolean }>('/system/fault', { enabled })).data

// 提取冲突响应中的草稿信息
export const getConflictData = (
  error: unknown,
): { serverRevision: number; draft?: BatchDraft; message: string } | null => {
  if (axios.isAxiosError(error) && error.response?.status === 409) {
    const data = error.response.data as { message: string; serverRevision?: number; draft?: BatchDraft }
    return {
      message: data.message,
      serverRevision: data.serverRevision ?? 0,
      draft: data.draft,
    }
  }
  return null
}
