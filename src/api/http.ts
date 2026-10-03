import axios, { type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios'
import { readDb, saveDb, type Database } from '@/mocks/db'
import type {
  Baseline,
  BatchDraft,
  BatchItem,
  DashboardData,
  DifferenceRegion,
  IgnoreRule,
  ImportRunPayload,
  Project,
  RecomputeResult,
  ReviewBatch,
  ReviewPayload,
  RunFilters,
  ScreenshotRun,
  StartReviewResult,
} from '@/types'
import {
  batchIdForKey,
  dedupeRegions,
  evaluateCollectingRegions,
  fragmentFingerprint,
  itemMismatchRate,
  mergeFragmentRegions,
  recomputeItemRegions,
  regionKey,
  snapshotRules,
} from '@/utils/batch'

export const api = axios.create({
  baseURL: '/mock-api',
  timeout: 8000,
  headers: { 'Content-Type': 'application/json' },
})

const respond = <T>(config: InternalAxiosRequestConfig, data: T, status = 200) => ({
  data,
  status,
  statusText: status === 200 ? 'OK' : status === 201 ? 'Created' : 'Conflict',
  headers: {},
  config,
})

interface ApiErrorBody {
  error: true
  code: string
  message: string
  draft?: BatchDraft
}

const fail = (
  config: InternalAxiosRequestConfig,
  status: number,
  code: string,
  message: string,
  extra?: Partial<ApiErrorBody>,
) => respond<ApiErrorBody>(config, { error: true, code, message, ...extra }, status)

const parseBody = <T>(config: InternalAxiosRequestConfig): T => {
  if (typeof config.data === 'string') return JSON.parse(config.data) as T
  return config.data as T
}

const uid = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

const rememberMutation = (db: Database, key: string | undefined) => {
  if (!key) return
  if (!db.appliedMutations.includes(key)) {
    db.appliedMutations.push(key)
    if (db.appliedMutations.length > 200) db.appliedMutations.splice(0, db.appliedMutations.length - 200)
  }
}

const scopedRules = (db: Database, projectId: string): IgnoreRule[] =>
  db.rules.filter((rule) => rule.projectId === 'all' || rule.projectId === projectId)

/** 用条目状态回写主分片与所有已归档分片，保证页面入口看到一致结论 */
const syncRunsOfItem = (
  db: Database,
  batch: ReviewBatch,
  item: BatchItem,
  baselineVersion?: string,
) => {
  const ids = [item.primaryRunId, ...item.fragmentRunIds]
  for (const run of db.runs) {
    if (!ids.includes(run.id)) continue
    if (run.id === item.primaryRunId) {
      run.batchId = batch.id
      run.itemId = item.id
      run.status = item.status
      run.review = item.review
      run.regions = item.regions.map((region) => ({ ...region }))
      run.mismatchRate = item.mismatchRate
      if (baselineVersion) run.baselineVersion = baselineVersion
    } else {
      // 归档分片同步审批结论，但不产生新的审批记录或基线
      run.status = 'archived'
      run.review = item.review
      run.batchId = batch.id
      run.itemId = item.id
      if (baselineVersion) run.baselineVersion = baselineVersion
    }
  }
}

const batchCompletion = (batch: ReviewBatch) => {
  if (batch.items.length > 0 && batch.items.every((item) => item.status !== 'pending')) {
    batch.stage = 'completed'
    batch.completedAt = new Date().toISOString()
  }
}

/**
 * 把一条分片运行吸收进项目+构建批次：
 * - 同页面/设备/主题首次出现 → 成为条目主运行；
 * - 重复分片（runId 或内容指纹命中）→ 只归档一次；
 * - 已批准条目的晚到分片只归档，不重开评审、不绕过旧基线；
 * - 未批准条目合并区域（几何指纹去重），并按阶段对应规则判定。
 */
const absorbFragment = (
  db: Database,
  batch: ReviewBatch,
  run: ScreenshotRun,
  fingerprint: string,
): { item: BatchItem; duplicated: boolean; created: boolean } => {
  let item = batch.items.find(
    (candidate) =>
      candidate.page === run.page &&
      candidate.device === run.device &&
      candidate.theme === run.theme,
  )

  if (!item) {
    item = {
      id: uid('item'),
      page: run.page,
      device: run.device,
      theme: run.theme,
      primaryRunId: run.id,
      fragmentRunIds: [],
      archivedFragments: [],
      regions: [],
      status: 'pending',
      mismatchRate: run.mismatchRate,
      updatedAt: run.receivedAt ?? run.capturedAt,
    }
    batch.items.push(item)
  }

  const alreadyArchived =
    item.archivedFragments.some(
      (fragment) => fragment.fingerprint === fingerprint || fragment.runId === run.id,
    ) || item.fragmentRunIds.includes(run.id) || item.primaryRunId === run.id

  if (alreadyArchived) {
    // 本轮刚建立条目的主运行不是“重复分片”
    const isPrimaryAbsorb = item.primaryRunId === run.id
    return { item, duplicated: !isPrimaryAbsorb, created: isPrimaryAbsorb }
  }

  const isPrimary = item.primaryRunId === run.id
  if (!isPrimary) {
    item.fragmentRunIds.push(run.id)
    item.archivedFragments.push({
      runId: run.id,
      fragmentIndex: run.fragmentIndex ?? item.archivedFragments.length + 1,
      fingerprint,
      executor: run.executor ?? 'unknown-runner',
      receivedAt: run.receivedAt ?? run.capturedAt,
      regionCount: run.regions.length,
    })
  }

  run.batchId = batch.id
  run.itemId = item.id

  if (item.status === 'approved') {
    // 已批准基线依据保持不动，晚到分片仅归档
    run.status = isPrimary ? item.status : 'archived'
    run.fragmentOfRunId = isPrimary ? undefined : item.primaryRunId
    syncRunsOfItem(db, batch, item)
    return { item, duplicated: false, created: false }
  }

  if (isPrimary) {
    run.status = 'pending'
  } else {
    run.status = 'archived'
    run.fragmentOfRunId = item.primaryRunId
  }

  const incoming = run.regions.map((region) => ({ ...region }))
  if (batch.stage === 'collecting') {
    item.regions = dedupeRegions(mergeFragmentRegions(item.regions, incoming))
    item.regions = evaluateCollectingRegions(item.regions, scopedRules(db, batch.projectId), {
      projectId: batch.projectId,
      page: item.page,
      device: item.device,
    })
  } else {
    // 已进入评审：新区域按进入时固定的快照判定，既有判定不变
    const existingKeys = new Set(item.regions.map((region) => regionKey(region)))
    const fresh = incoming.filter((region) => !existingKeys.has(regionKey(region)))
    const judgedFresh = applyFrozenSnapshot(fresh, batch)
    item.regions = dedupeRegions([...item.regions, ...judgedFresh])
  }

  item.mismatchRate = itemMismatchRate(item)
  item.updatedAt = run.receivedAt ?? new Date().toISOString()
  syncRunsOfItem(db, batch, item)
  return { item, duplicated: false, created: true }
}

const applyFrozenSnapshot = (
  regions: DifferenceRegion[],
  batch: ReviewBatch,
): DifferenceRegion[] => {
  const snapshots = batch.ruleSnapshots
  return regions.map((region) => {
    const matched = snapshots.find(
      (snapshot) =>
        snapshot.enabled &&
        (region.kind === 'environment' || region.ruleId === snapshot.id) &&
        (region.delta ?? 0) <= snapshot.maxDelta,
    )
    if (matched) {
      return { ...region, ignored: true, ruleId: matched.id, decision: 'ignored', source: 'rule' }
    }
    return { ...region, decision: 'pending', ignored: false }
  })
}

const ensureBatch = (db: Database, projectId: string, build: string): ReviewBatch => {
  const id = batchIdForKey(projectId, build)
  let batch = db.batches.find((candidate) => candidate.id === id)
  if (!batch) {
    batch = {
      id,
      projectId,
      build,
      name: `${build} 回归批次`,
      stage: 'collecting',
      version: 1,
      ruleSnapshotId: '',
      ruleSnapshots: [],
      items: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    db.batches.unshift(batch)
  }
  return batch
}

const mockAdapter: AxiosAdapter = async (config) => {
  await new Promise((resolve) => window.setTimeout(resolve, 180))
  const db = readDb()
  const method = (config.method ?? 'get').toLowerCase()
  const path = config.url ?? ''

  if (method === 'get' && path === '/projects') {
    return respond<Project[]>(config, db.projects)
  }

  if (method === 'get' && path === '/dashboard') {
    const primaryRuns = db.runs.filter((run) => !run.fragmentOfRunId && run.status !== 'archived')
    const dashboard: DashboardData = {
      pendingReview: primaryRuns.filter((run) => run.status === 'pending').length,
      approvedToday: primaryRuns.filter(
        (run) =>
          run.review?.decision === 'approved' && run.review.reviewedAt.startsWith('2026-09-29'),
      ).length,
      highRisk: primaryRuns.filter(
        (run) => run.mismatchRate >= 5 && run.status !== 'merged',
      ).length,
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
    const includeFragments = filters.includeFragments === true
    const keyword = filters.keyword?.trim().toLowerCase()
    const data = db.runs.filter((run) => {
      if (!includeFragments && (run.fragmentOfRunId || run.status === 'archived')) return false
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
    if (!run) return fail(config, 404, 'RUN_NOT_FOUND', '运行记录不存在')
    return respond(config, run)
  }

  // ─── 评审批次 ───────────────────────────────────────────────

  if (method === 'get' && path === '/batches') {
    const projectId = config.params?.projectId as string | undefined
    const data = db.batches
      .filter((batch) => !projectId || batch.projectId === projectId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return respond(config, data)
  }

  const batchMatch = path.match(/^\/batches\/([^/]+)$/)
  if (method === 'get' && batchMatch) {
    const batch = db.batches.find((item) => item.id === batchMatch[1])
    if (!batch) return fail(config, 404, 'BATCH_NOT_FOUND', '评审批次不存在')
    return respond(config, batch)
  }

  // 进入评审：固定规则快照与区域判定基线
  const startMatch = path.match(/^\/batches\/([^/]+)\/start-review$/)
  if (method === 'post' && startMatch) {
    const batch = db.batches.find((item) => item.id === startMatch[1])
    if (!batch) return fail(config, 404, 'BATCH_NOT_FOUND', '评审批次不存在')
    if (batch.stage === 'collecting') {
      const now = new Date().toISOString()
      const snapshots = snapshotRules(scopedRules(db, batch.projectId), now)
      batch.stage = 'in-review'
      batch.reviewStartedAt = now
      batch.ruleSnapshotId = `snapshot-${batch.id}-${batch.version}`
      batch.ruleSnapshots = snapshots
      for (const item of batch.items) {
        item.regions = applyFrozenSnapshot(item.regions, batch).map((region) => ({
          ...region,
        }))
        item.mismatchRate = itemMismatchRate(item)
        syncRunsOfItem(db, batch, item)
      }
      batch.version += 1
      batch.updatedAt = now
      await saveDb(db)
      return respond<StartReviewResult>(config, { batch, started: true })
    }
    return respond<StartReviewResult>(config, { batch, started: false })
  }

  // 规则变化 / 新分片到达后重算：只动未批准条目与未固定区域
  const recomputeMatch = path.match(/^\/batches\/([^/]+)\/recompute$/)
  if (method === 'post' && recomputeMatch) {
    const batch = db.batches.find((item) => item.id === recomputeMatch[1])
    if (!batch) return fail(config, 404, 'BATCH_NOT_FOUND', '评审批次不存在')
    if (batch.stage === 'collecting') {
      return fail(config, 400, 'BATCH_NOT_STARTED', '批次尚未进入评审，无需重算')
    }
    const liveSnapshots = snapshotRules(scopedRules(db, batch.projectId))
    let pinnedCount = 0
    let recomputedCount = 0
    for (const item of batch.items) {
      pinnedCount += item.regions.filter((region) => region.pinned).length
      if (item.status !== 'pending') continue
      const result = recomputeItemRegions(item, liveSnapshots)
      item.regions = result.regions
      recomputedCount += result.recomputedCount
      item.mismatchRate = itemMismatchRate(item)
      item.updatedAt = new Date().toISOString()
      syncRunsOfItem(db, batch, item)
    }
    batch.version += 1
    batch.updatedAt = new Date().toISOString()
    await saveDb(db)
    return respond<RecomputeResult>(config, { batch, pinnedCount, recomputedCount })
  }

  // 提交单条目评审结论（乐观锁 + 幂等）
  const reviewSubmitMatch = path.match(
    /^\/batches\/([^/]+)\/items\/([^/]+)\/review$/,
  )
  if (method === 'post' && reviewSubmitMatch) {
    const payload = parseBody<ReviewPayload>(config)
    const batch = db.batches.find((item) => item.id === reviewSubmitMatch[1])
    if (!batch) return fail(config, 404, 'BATCH_NOT_FOUND', '评审批次不存在')
    const item = batch.items.find((candidate) => candidate.id === reviewSubmitMatch[2])
    if (!item) return fail(config, 404, 'ITEM_NOT_FOUND', '批次内页面条目不存在')

    const expected = payload.expectedVersion ?? batch.version
    if (expected !== batch.version) {
      // 后到窗口：保存失败，完整表单留作草稿
      const draft: BatchDraft = {
        id: uid('draft'),
        batchId: batch.id,
        itemId: item.id,
        expectedVersion: expected,
        payload: {
          category: payload.category,
          decision: payload.decision,
          reviewer: payload.reviewer,
          reason: payload.reason,
        },
        createdAt: new Date().toISOString(),
        reason: `批次已被另一窗口更新到 v${batch.version}，本窗口基于 v${expected} 的提交未保存`,
      }
      db.drafts.unshift(draft)
      await saveDb(db)
      return fail(
        config,
        409,
        'BATCH_VERSION_CONFLICT',
        '另一窗口已先提交本批次，本次保存未生效，已保留为草稿。',
        { draft },
      )
    }

    const idempotencyKey = payload.idempotencyKey ?? uid('review')
    if (idempotencyKey && db.appliedMutations.includes(idempotencyKey)) {
      return respond(config, batch)
    }

    const reviewedAt = new Date().toISOString()
    item.status = payload.decision
    item.review = {
      category: payload.category,
      decision: payload.decision,
      reviewer: payload.reviewer,
      reason: payload.reason,
      reviewedAt,
      batchVersion: batch.version,
      idempotencyKey,
    }
    // 审批后区域判定全部固定，任何重算都不会再动
    for (const region of item.regions) region.pinned = true
    item.updatedAt = reviewedAt

    let previousBaselineVersion: string | undefined
    if (payload.decision === 'approved') {
      const existingBaseline = db.baselines.find(
        (baseline) => baseline.idempotencyKey === idempotencyKey,
      )
      if (!existingBaseline) {
        const previous = db.baselines.find(
          (baseline) =>
            baseline.projectId === batch.projectId &&
            baseline.page === item.page &&
            baseline.device === item.device &&
            baseline.theme === item.theme &&
            baseline.active,
        )
        if (previous) {
          previous.active = false
          item.previousBaselineId = previous.id
          previousBaselineVersion = previous.version
        }
        const primaryRun = db.runs.find((run) => run.id === item.primaryRunId)
        const baseline: Baseline = {
          id: uid('base'),
          projectId: batch.projectId,
          page: item.page,
          pageName: item.page,
          device: item.device,
          theme: item.theme,
          version: primaryRun?.currentVersion ?? `${batch.build}-approved`,
          approvedBy: payload.reviewer,
          reason: payload.reason,
          approvedAt: reviewedAt,
          runId: item.primaryRunId,
          batchId: batch.id,
          itemId: item.id,
          previousBaselineId: previous?.id,
          idempotencyKey,
          active: true,
        }
        db.baselines.unshift(baseline)
        item.baselineId = baseline.id
      }
    }

    rememberMutation(db, idempotencyKey)
    batch.version += 1
    batch.updatedAt = reviewedAt
    batchCompletion(batch)
    syncRunsOfItem(db, batch, item, previousBaselineVersion)
    await saveDb(db)
    return respond(config, batch)
  }

  // 区域判定：忽略 / 确认，固定后不受重算影响
  const regionMatch = path.match(
    /^\/batches\/([^/]+)\/items\/([^/]+)\/regions\/([^/]+)$/,
  )
  if (method === 'patch' && regionMatch) {
    const body = parseBody<{ decision: 'ignored' | 'confirmed'; expectedVersion?: number }>(config)
    const batch = db.batches.find((item) => item.id === regionMatch[1])
    if (!batch) return fail(config, 404, 'BATCH_NOT_FOUND', '评审批次不存在')
    const item = batch.items.find((candidate) => candidate.id === regionMatch[2])
    if (!item) return fail(config, 404, 'ITEM_NOT_FOUND', '批次内页面条目不存在')
    if (batch.stage === 'collecting') {
      return fail(config, 400, 'BATCH_NOT_STARTED', '请先进入评审，区域判定才会固定')
    }
    if (item.status === 'approved') {
      return fail(config, 400, 'ITEM_LOCKED', '该页面已批准，区域判定不可修改')
    }
    const expected = body.expectedVersion ?? batch.version
    if (expected !== batch.version) {
      return fail(
        config,
        409,
        'BATCH_VERSION_CONFLICT',
        '批次内容已在其他窗口更新，请刷新后继续。',
      )
    }
    const region = item.regions.find((candidate) => candidate.id === regionMatch[3])
    if (!region) return fail(config, 404, 'REGION_NOT_FOUND', '差异区域不存在')
    region.decision = body.decision
    region.source = 'manual'
    region.pinned = true
    region.ignored = body.decision === 'ignored'
    if (body.decision === 'confirmed') region.ruleId = undefined
    item.mismatchRate = itemMismatchRate(item)
    item.updatedAt = new Date().toISOString()
    batch.version += 1
    batch.updatedAt = item.updatedAt
    syncRunsOfItem(db, batch, item)
    await saveDb(db)
    return respond(config, batch)
  }

  if (method === 'get' && path === '/drafts') {
    return respond(config, { drafts: db.drafts })
  }

  const draftMatch = path.match(/^\/drafts\/([^/]+)$/)
  if (method === 'delete' && draftMatch) {
    const index = db.drafts.findIndex((draft) => draft.id === draftMatch[1])
    if (index < 0) return fail(config, 404, 'DRAFT_NOT_FOUND', '草稿不存在或已处理')
    const [removed] = db.drafts.splice(index, 1)
    await saveDb(db)
    return respond(config, removed)
  }

  if (method === 'post' && path === '/runs/merge') {
    const ids = parseBody<string[]>(config)
    const selected = db.runs.filter((run) => ids.includes(run.id))
    if (selected.length < 2) return fail(config, 400, 'MERGE_TOO_FEW', '至少选择两条运行记录进行合并')

    const first = selected[0]
    const processedBatches = new Set<string>()
    const seenKeys = new Set<string>()
    for (const run of selected) {
      const batch = ensureBatch(db, run.projectId, run.build)
      const key = `${run.page}::${run.device}::${run.theme}`
      const fingerprint = fragmentFingerprint({
        projectId: run.projectId,
        build: run.build,
        page: run.page,
        device: run.device,
        theme: run.theme,
        name: run.id,
        size: run.regions.length,
      })
      if (!seenKeys.has(key)) {
        seenKeys.add(key)
        if (!batch.items.some((item) => item.primaryRunId === run.id)) {
          absorbFragment(db, batch, run, fingerprint)
        }
      } else {
        absorbFragment(db, batch, run, fingerprint)
      }
      batch.updatedAt = new Date().toISOString()
      processedBatches.add(batch.id)
    }
    for (const batch of db.batches) {
      if (processedBatches.has(batch.id)) batch.version += 1
    }
    await saveDb(db)
    const result = db.runs.find((run) => run.id === first.id) ?? first
    return respond(config, result, 201)
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
      return fail(config, 400, 'IMPORT_INVALID', '项目、页面、设备、构建版本和截图文件不能为空')
    }

    const batch = ensureBatch(db, payload.projectId, payload.build.trim())
    const imported: ScreenshotRun[] = []
    let duplicated = 0
    let created = 0

    payload.files.forEach((file, index) => {
      const fragmentIndex = payload.fragmentIndex ?? index + 1
      const fingerprint =
        payload.fingerprint ??
        fragmentFingerprint({
          projectId: payload.projectId,
          build: payload.build,
          page: payload.page,
          device: payload.device,
          theme: payload.theme,
          name: file.name,
          size: file.size,
          fragmentIndex,
        })

      const existingItem = batch.items.find(
        (candidate) =>
          candidate.page === payload.page.trim() &&
          candidate.device === payload.device.trim() &&
          candidate.theme === payload.theme,
      )
      if (
        existingItem?.archivedFragments.some((fragment) => fragment.fingerprint === fingerprint)
      ) {
        duplicated += 1
        const duplicateRun = db.runs.find(
          (run) =>
            run.id ===
            existingItem.archivedFragments.find((fragment) => fragment.fingerprint === fingerprint)
              ?.runId,
        )
        if (duplicateRun) imported.push(duplicateRun)
        return
      }

      const runId = uid('run')
      const mismatchRate = Number((0.8 + ((file.name.length + index * 3) % 58) / 10).toFixed(2))
      const severity = mismatchRate >= 5 ? 'high' : mismatchRate >= 2 ? 'medium' : 'low'
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
        receivedAt: new Date().toISOString(),
        baselineVersion: payload.baselineVersion.trim() || '当前有效基线',
        currentVersion: payload.currentVersion.trim() || payload.build.trim(),
        baselineImage: payload.baselineImage,
        currentImage: file.dataUrl,
        executor: payload.executor ?? 'manual-upload',
        fragmentIndex,
        fingerprint,
        regions: [
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
            delta: 36,
            decision: 'pending',
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
            delta: 14,
            decision: 'pending',
          },
        ],
      }

      db.runs.unshift(run)
      const result = absorbFragment(db, batch, run, fingerprint)
      if (result.duplicated) duplicated += 1
      if (result.created) created += 1
      imported.push(run)
    })

    if (created > 0) batch.version += 1
    batch.updatedAt = new Date().toISOString()
    await saveDb(db)
    return respond(config, { runs: imported, duplicated, batchId: batch.id }, 201)
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
    const input = parseBody<Omit<IgnoreRule, 'id' | 'createdAt' | 'updatedAt'>>(config)
    const now = new Date().toISOString()
    const rule: IgnoreRule = {
      ...input,
      id: uid('rule'),
      createdAt: now,
      updatedAt: now,
    }
    db.rules.unshift(rule)
    await saveDb(db)
    return respond(config, rule, 201)
  }

  const ruleMatch = path.match(/^\/rules\/([^/]+)$/)
  if (method === 'patch' && ruleMatch) {
    const payload = parseBody<Partial<IgnoreRule>>(config)
    const rule = db.rules.find((item) => item.id === ruleMatch[1])
    if (!rule) return fail(config, 404, 'RULE_NOT_FOUND', '规则不存在')
    Object.assign(rule, payload, { updatedAt: new Date().toISOString() })
    await saveDb(db)
    // 收集期批次立即按新规则重新判定（无版本副作用，评审中批次需手动重算）
    for (const batch of db.batches) {
      if (batch.stage !== 'collecting') continue
      let touched = false
      for (const item of batch.items) {
        const next = evaluateCollectingRegions(item.regions, scopedRules(db, batch.projectId), {
          projectId: batch.projectId,
          page: item.page,
          device: item.device,
        })
        if (next.some((region, index) => region.ignored !== item.regions[index]?.ignored)) {
          item.regions = next
          item.mismatchRate = itemMismatchRate(item)
          touched = true
        }
      }
      if (touched) {
        batch.updatedAt = new Date().toISOString()
        for (const item of batch.items) syncRunsOfItem(db, batch, item)
      }
    }
    await saveDb(db)
    return respond(config, rule)
  }
  if (method === 'delete' && ruleMatch) {
    const index = db.rules.findIndex((item) => item.id === ruleMatch[1])
    if (index < 0) return fail(config, 404, 'RULE_NOT_FOUND', '规则不存在')
    db.rules.splice(index, 1)
    await saveDb(db)
    return respond(config, { success: true })
  }

  return fail(config, 404, 'API_NOT_FOUND', `Mock API 未实现：${method.toUpperCase()} ${path}`)
}

api.defaults.adapter = mockAdapter

// ─── API 封装 ─────────────────────────────────────────────────

export interface ImportRunsResult {
  runs: ScreenshotRun[]
  duplicated: number
  batchId: string
}

export const getProjects = async (): Promise<Project[]> => (await api.get<Project[]>('/projects')).data
export const getDashboard = async (): Promise<DashboardData> =>
  (await api.get<DashboardData>('/dashboard')).data
export const getRuns = async (filters: RunFilters = {}): Promise<ScreenshotRun[]> =>
  (await api.get<ScreenshotRun[]>('/runs', { params: filters })).data
export const getRun = async (id: string): Promise<ScreenshotRun> =>
  (await api.get<ScreenshotRun>(`/runs/${id}`)).data
export const getBatches = async (projectId?: string): Promise<ReviewBatch[]> =>
  (await api.get<ReviewBatch[]>('/batches', { params: { projectId } })).data
export const getBatch = async (id: string): Promise<ReviewBatch> =>
  (await api.get<ReviewBatch>(`/batches/${id}`)).data
export const startReview = async (id: string): Promise<StartReviewResult> =>
  (await api.post<StartReviewResult>(`/batches/${id}/start-review`)).data
export const recomputeBatch = async (id: string): Promise<RecomputeResult> =>
  (await api.post<RecomputeResult>(`/batches/${id}/recompute`)).data
export const submitItemReview = async (
  batchId: string,
  itemId: string,
  payload: ReviewPayload,
): Promise<ReviewBatch> =>
  (
    await api.post<ReviewBatch>(`/batches/${batchId}/items/${itemId}/review`, payload)
  ).data
export const setRegionDecision = async (
  batchId: string,
  itemId: string,
  regionId: string,
  decision: 'ignored' | 'confirmed',
  expectedVersion: number,
): Promise<ReviewBatch> =>
  (
    await api.patch<ReviewBatch>(
      `/batches/${batchId}/items/${itemId}/regions/${regionId}`,
      { decision, expectedVersion },
    )
  ).data
export const getDrafts = async (): Promise<BatchDraft[]> =>
  (await api.get<{ drafts: BatchDraft[] }>('/drafts')).data.drafts
export const discardDraft = async (id: string): Promise<BatchDraft> =>
  (await api.delete<BatchDraft>(`/drafts/${id}`)).data
export const mergeRuns = async (ids: string[]): Promise<ScreenshotRun> =>
  (await api.post<ScreenshotRun>('/runs/merge', ids)).data
export const importRuns = async (payload: ImportRunPayload): Promise<ImportRunsResult> =>
  (await api.post<ImportRunsResult>('/runs/import', payload)).data
export const getBaselines = async (projectId?: string): Promise<Baseline[]> =>
  (await api.get<Baseline[]>('/baselines', { params: { projectId } })).data
export const getRules = async (): Promise<IgnoreRule[]> =>
  (await api.get<IgnoreRule[]>('/rules')).data
export const createRule = async (
  payload: Omit<IgnoreRule, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<IgnoreRule> => (await api.post<IgnoreRule>('/rules', payload)).data
export const toggleRule = async (id: string, enabled: boolean): Promise<IgnoreRule> =>
  (await api.patch<IgnoreRule>(`/rules/${id}`, { enabled })).data
export const deleteRule = async (id: string): Promise<{ success: boolean }> =>
  (await api.delete<{ success: boolean }>(`/rules/${id}`)).data

/** 从 axios 错误体里提取后端消息与冲突草稿 */
export interface ApiError {
  status?: number
  code?: string
  message: string
  draft?: BatchDraft
}

export const toApiError = (error: unknown): ApiError => {
  const candidate = error as { response?: { status?: number; data?: ApiErrorBody }; message?: string }
  if (candidate.response?.data) {
    return {
      status: candidate.response.status,
      code: candidate.response.data.code,
      message: candidate.response.data.message,
      draft: candidate.response.data.draft,
    }
  }
  return { message: candidate.message ?? '请求失败，请稍后重试' }
}
