import type {
  Baseline,
  BatchItem,
  DifferenceRegion,
  IgnoreRule,
  Project,
  ReviewBatch,
  BatchDraft,
  ReviewRecord,
  RuleSnapshot,
  ScreenshotRun,
} from '@/types'
import { loadSnapshot, persistSnapshot } from './storage'
import {
  batchIdForKey,
  dedupeRegions,
  fragmentFingerprint,
  mergeFragmentRegions,
  regionKey,
  snapshotRules,
} from '@/utils/batch'

export interface Database {
  version: 2
  projects: Project[]
  runs: ScreenshotRun[]
  baselines: Baseline[]
  rules: IgnoreRule[]
  batches: ReviewBatch[]
  drafts: BatchDraft[]
  /** 已应用的幂等变更键，重启恢复后不重复区域 / 审批记录 */
  appliedMutations: string[]
}

const projects: Project[] = [
  { id: 'p-commerce', name: '零售交易工作台', code: 'RETAIL', owner: '沈宁', pageCount: 42 },
  { id: 'p-console', name: '云资源控制台', code: 'CLOUD', owner: '周航', pageCount: 67 },
  { id: 'p-growth', name: '增长运营平台', code: 'GROWTH', owner: '许薇', pageCount: 31 },
]

const makeRegions = (prefix: string, intensity: number): DifferenceRegion[] => [
  {
    id: `${prefix}-r1`,
    x: 11,
    y: 18,
    width: 28,
    height: 16,
    severity: 'high',
    pixels: Math.round(1840 * intensity),
    kind: 'layout',
    ignored: false,
    delta: 46,
    decision: 'pending',
  },
  {
    id: `${prefix}-r2`,
    x: 54,
    y: 34,
    width: 19,
    height: 11,
    severity: 'medium',
    pixels: Math.round(720 * intensity),
    kind: 'color',
    ignored: false,
    delta: 21,
    decision: 'pending',
  },
  {
    id: `${prefix}-r3`,
    x: 72,
    y: 71,
    width: 18,
    height: 13,
    severity: 'low',
    pixels: Math.round(216 * intensity),
    kind: 'environment',
    ignored: true,
    ruleId: 'rule-time',
    delta: 6,
    decision: 'ignored',
    source: 'rule',
  },
]

/** 执行机分片回传示例：与 run-1048 同项目同构建同页面，到达更晚 */
const fragmentRegions: DifferenceRegion[] = [
  {
    // 与主分片 r1 同几何位置，归档合并时去重，不会重复
    id: '1049-r1',
    x: 11,
    y: 18,
    width: 28,
    height: 16,
    severity: 'high',
    pixels: 1905,
    kind: 'layout',
    ignored: false,
    delta: 47,
    decision: 'pending',
  },
  {
    id: '1049-r4',
    x: 40,
    y: 60,
    width: 20,
    height: 12,
    severity: 'medium',
    pixels: 640,
    kind: 'color',
    ignored: false,
    delta: 18,
    decision: 'pending',
  },
]

const runs: ScreenshotRun[] = [
  {
    id: 'run-1048',
    name: '结算页桌面端回归',
    projectId: 'p-commerce',
    page: '订单结算页',
    device: 'Desktop 1440',
    theme: 'light',
    build: 'release/6.18.0',
    status: 'pending',
    mismatchRate: 3.82,
    capturedAt: '2026-09-29T08:42:00+08:00',
    baselineVersion: 'v6.17.4-baseline',
    currentVersion: 'v6.18.0-rc2',
    regions: makeRegions('1048', 1),
    executor: 'executor-shard-1',
    fragmentIndex: 1,
    receivedAt: '2026-09-29T08:44:10+08:00',
  },
  {
    id: 'run-1049',
    name: '结算页桌面端回归',
    projectId: 'p-commerce',
    page: '订单结算页',
    device: 'Desktop 1440',
    theme: 'light',
    build: 'release/6.18.0',
    status: 'pending',
    mismatchRate: 3.95,
    capturedAt: '2026-09-29T08:42:00+08:00',
    baselineVersion: 'v6.17.4-baseline',
    currentVersion: 'v6.18.0-rc2',
    regions: fragmentRegions,
    fragmentOfRunId: 'run-1048',
    executor: 'executor-shard-2',
    fragmentIndex: 2,
    receivedAt: '2026-09-29T09:05:31+08:00',
  },
  {
    id: 'run-1047',
    name: '商品列表移动端回归',
    projectId: 'p-commerce',
    page: '商品列表页',
    device: 'iPhone 15',
    theme: 'light',
    build: 'release/6.18.0',
    status: 'pending',
    mismatchRate: 1.36,
    capturedAt: '2026-09-29T08:36:00+08:00',
    baselineVersion: 'v6.17.4-baseline',
    currentVersion: 'v6.18.0-rc2',
    regions: makeRegions('1047', 0.7),
  },
  {
    id: 'run-1046',
    name: '账单明细暗色主题回归',
    projectId: 'p-console',
    page: '账单明细',
    device: 'Desktop 1920',
    theme: 'dark',
    build: 'feature/billing-v3',
    status: 'approved',
    mismatchRate: 5.14,
    capturedAt: '2026-09-28T17:20:00+08:00',
    baselineVersion: 'v5.9.1-baseline',
    currentVersion: 'billing-v3.7',
    regions: makeRegions('1046', 1.4),
    review: {
      category: 'design-change',
      decision: 'approved',
      reviewer: '林默',
      reason: '新计费周期列按需求上线，已核对设计稿和验收单。',
      reviewedAt: '2026-09-28T18:02:00+08:00',
    },
  },
  {
    id: 'run-1045',
    name: '活动配置页移动端回归',
    projectId: 'p-growth',
    page: '活动配置',
    device: 'Android Pixel 8',
    theme: 'light',
    build: 'feature/campaign-editor',
    status: 'rejected',
    mismatchRate: 10.73,
    capturedAt: '2026-09-28T15:11:00+08:00',
    baselineVersion: 'v2.4.0-baseline',
    currentVersion: 'campaign-v2',
    regions: makeRegions('1045', 2.2),
    review: {
      category: 'render-error',
      decision: 'rejected',
      reviewer: '梁琪',
      reason: '主操作区被侧栏遮挡，属于阻断性渲染异常。',
      reviewedAt: '2026-09-28T15:44:00+08:00',
    },
  },
  {
    id: 'run-1044',
    name: '资源详情页桌面端回归',
    projectId: 'p-console',
    page: '资源详情',
    device: 'Desktop 1440',
    theme: 'light',
    build: 'release/5.10.0',
    status: 'pending',
    mismatchRate: 2.08,
    capturedAt: '2026-09-28T13:30:00+08:00',
    baselineVersion: 'v5.9.1-baseline',
    currentVersion: 'v5.10.0-rc1',
    regions: makeRegions('1044', 0.9),
  },
  {
    id: 'run-1043',
    name: '首页推荐位回归',
    projectId: 'p-growth',
    page: '运营首页',
    device: 'Desktop 1440',
    theme: 'light',
    build: 'release/2.6.0',
    status: 'pending',
    mismatchRate: 0.94,
    capturedAt: '2026-09-27T19:15:00+08:00',
    baselineVersion: 'v2.5.3-baseline',
    currentVersion: 'v2.6.0-rc3',
    regions: makeRegions('1043', 0.5),
  },
]

const baselines: Baseline[] = [
  {
    id: 'base-commerce-checkout',
    projectId: 'p-commerce',
    pageName: '订单结算页',
    page: '订单结算页',
    device: 'Desktop 1440',
    theme: 'light',
    version: 'v6.17.4-baseline',
    approvedBy: '林默',
    reason: '合入优惠券区域改版，设计稿版本 DS-318。',
    approvedAt: '2026-09-19T11:30:00+08:00',
    runId: 'run-998',
    active: true,
  },
  {
    id: 'base-console-billing',
    projectId: 'p-console',
    pageName: '账单明细',
    page: '账单明细',
    device: 'Desktop 1920',
    theme: 'dark',
    version: 'v5.9.1-baseline',
    approvedBy: '周航',
    reason: '升级账单表格主题变量，无业务布局变化。',
    approvedAt: '2026-09-12T14:05:00+08:00',
    runId: 'run-961',
    active: true,
  },
  {
    id: 'base-growth-campaign',
    projectId: 'p-growth',
    pageName: '活动配置',
    page: '活动配置',
    device: 'Android Pixel 8',
    theme: 'light',
    version: 'v2.4.0-baseline',
    approvedBy: '许薇',
    reason: '第一版移动端活动配置工作台基线。',
    approvedAt: '2026-08-28T10:10:00+08:00',
    runId: 'run-902',
    active: false,
  },
  {
    id: 'base-commerce-list',
    projectId: 'p-commerce',
    pageName: '商品列表页',
    page: '商品列表页',
    device: 'iPhone 15',
    theme: 'light',
    version: 'v6.17.4-baseline',
    approvedBy: '沈宁',
    reason: '商品卡信息密度调整完成，已通过交互验收。',
    approvedAt: '2026-09-20T16:40:00+08:00',
    runId: 'run-1002',
    active: true,
  },
]

const rules: IgnoreRule[] = [
  {
    id: 'rule-time',
    name: '动态时间区域',
    projectId: 'all',
    selector: '[data-visual-ignore="relative-time"]',
    pagePattern: '*',
    devicePattern: '*',
    maxDelta: 12,
    enabled: true,
    createdAt: '2026-09-02T09:00:00+08:00',
    updatedAt: '2026-09-02T09:00:00+08:00',
  },
  {
    id: 'rule-avatar',
    name: '用户头像随机图',
    projectId: 'p-commerce',
    selector: '.user-avatar img',
    pagePattern: '/checkout/*',
    devicePattern: '*',
    maxDelta: 20,
    enabled: true,
    createdAt: '2026-09-05T13:25:00+08:00',
    updatedAt: '2026-09-05T13:25:00+08:00',
  },
  {
    id: 'rule-watermark',
    name: '测试环境水印',
    projectId: 'all',
    selector: '.environment-watermark',
    pagePattern: '*',
    devicePattern: '*',
    maxDelta: 5,
    enabled: true,
    createdAt: '2026-08-21T11:08:00+08:00',
    updatedAt: '2026-08-21T11:08:00+08:00',
  },
  {
    id: 'rule-animation',
    name: '旧版骨架屏动画',
    projectId: 'p-console',
    selector: '.skeleton-shimmer',
    pagePattern: '*',
    devicePattern: 'iPhone*',
    maxDelta: 8,
    enabled: false,
    createdAt: '2026-08-16T17:12:00+08:00',
    updatedAt: '2026-08-16T17:12:00+08:00',
  },
]

/** 旧版（v1）数据库形状，迁移时按字段容忍读取 */
interface LegacyDatabase {
  projects?: Project[]
  runs?: ScreenshotRun[]
  baselines?: Baseline[]
  rules?: IgnoreRule[]
}

const MIGRATED_AT = '2026-09-29T09:00:00+08:00'

const migrateRegions = (regions: DifferenceRegion[] | undefined): DifferenceRegion[] =>
  (regions ?? []).map((region, index) => {
    const ignored = Boolean(region.ignored)
    return {
      ...region,
      delta:
        typeof region.delta === 'number'
          ? region.delta
          : ignored && region.ruleId
            ? 6
            : region.kind === 'environment'
              ? 4
              : 30 + index,
      decision: region.decision ?? (ignored ? 'ignored' : 'pending'),
      source: region.source ?? (ignored && region.ruleId ? 'rule' : undefined),
      pinned: region.pinned ?? false,
    }
  })

const itemKeyOf = (run: ScreenshotRun) => `${run.page}::${run.device}::${run.theme}`

/**
 * 把没有批次归属的旧运行补成批次：
 * 同项目同一构建归入一个评审批次，同页面/设备/主题只保留一个条目，
 * 其余运行作为已归档分片；旧运行单独成组时即“单运行批次”，原页面入口不变。
 */
const buildBatchesFromLegacyRuns = (
  legacyRuns: ScreenshotRun[],
  allRules: IgnoreRule[],
): { batches: ReviewBatch[]; runs: ScreenshotRun[] } => {
  const runs = legacyRuns.map((run) => ({
    ...run,
    regions: migrateRegions(run.regions),
  }))

  const fragments = runs.filter((run) => run.fragmentOfRunId)
  const primaries = runs.filter((run) => !run.fragmentOfRunId)

  const groups = new Map<string, ScreenshotRun[]>()
  for (const run of primaries) {
    const key = `${run.projectId}::${run.build}`
    const list = groups.get(key) ?? []
    list.push(run)
    groups.set(key, list)
  }

  const batches: ReviewBatch[] = []
  const nextRuns: ScreenshotRun[] = []

  for (const [groupKey, groupRuns] of groups) {
    const [projectId, build] = [groupKey.split('::')[0], groupKey.slice(groupKey.indexOf('::') + 2)]
    const ordered = [...groupRuns].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))
    const itemMap = new Map<string, BatchItem & { run: ScreenshotRun }>()

    for (const run of ordered) {
      const key = itemKeyOf(run)
      const existing = itemMap.get(key)
      if (existing) {
        // 同页面/设备/主题的重复运行：作为分片归档，只归档一次
        const fingerprint =
          run.fingerprint ??
          fragmentFingerprint({
            projectId: run.projectId,
            build: run.build,
            page: run.page,
            device: run.device,
            theme: run.theme,
            name: run.id,
            size: run.regions.length,
            fragmentIndex: run.fragmentIndex,
          })
        if (
          !existing.archivedFragments.some(
            (fragment) => fragment.fingerprint === fingerprint || fragment.runId === run.id,
          )
        ) {
          existing.regions = dedupeRegions(
            mergeFragmentRegions(existing.regions, run.regions.map((region) => ({ ...region }))),
          )
          existing.fragmentRunIds.push(run.id)
          existing.archivedFragments.push({
            runId: run.id,
            fragmentIndex: run.fragmentIndex ?? existing.archivedFragments.length + 1,
            fingerprint,
            executor: run.executor ?? 'legacy-runner',
            receivedAt: run.receivedAt ?? run.capturedAt,
            regionCount: run.regions.length,
          })
        }
        nextRuns.push({
          ...run,
          status: 'archived',
          batchId: undefined,
          itemId: undefined,
          fragmentOfRunId: existing.primaryRunId,
        })
      } else {
        const status: BatchItem['status'] =
          run.status === 'approved' || run.status === 'rejected' ? run.status : 'pending'
        const review: ReviewRecord | undefined = run.review
          ? { ...run.review, batchVersion: 1 }
          : undefined
        const item: BatchItem & { run: ScreenshotRun } = {
          run,
          id: `item-${run.id}`,
          page: run.page,
          device: run.device,
          theme: run.theme,
          primaryRunId: run.id,
          fragmentRunIds: [],
          archivedFragments: [],
          regions: run.regions.map((region) => ({ ...region })),
          status,
          review,
          mismatchRate: run.mismatchRate,
          updatedAt: run.review?.reviewedAt ?? run.capturedAt,
        }
        itemMap.set(key, item)
      }
    }

    // 附加显式标记的分片（如执行机晚到的 run-1049）
    for (const fragment of fragments) {
      const owner = ordered.find((run) => run.id === fragment.fragmentOfRunId)
      if (!owner || owner.projectId !== projectId || owner.build !== build) continue
      const item = itemMap.get(itemKeyOf(fragment))
      if (!item) continue
      const fingerprint =
        fragment.fingerprint ??
        fragmentFingerprint({
          projectId: fragment.projectId,
          build: fragment.build,
          page: fragment.page,
          device: fragment.device,
          theme: fragment.theme,
          name: fragment.id,
          size: fragment.regions.length,
          fragmentIndex: fragment.fragmentIndex,
        })
      if (
        item.archivedFragments.some(
          (archived) => archived.fingerprint === fingerprint || archived.runId === fragment.id,
        )
      ) {
        continue
      }
      item.regions = dedupeRegions(
        mergeFragmentRegions(item.regions, fragment.regions.map((region) => ({ ...region }))),
      )
      item.fragmentRunIds.push(fragment.id)
      item.archivedFragments.push({
        runId: fragment.id,
        fragmentIndex: fragment.fragmentIndex ?? item.archivedFragments.length + 1,
        fingerprint,
        executor: fragment.executor ?? 'unknown-runner',
        receivedAt: fragment.receivedAt ?? fragment.capturedAt,
        regionCount: fragment.regions.length,
      })
      nextRuns.push({
        ...fragment,
        status: 'archived',
        batchId: undefined,
        itemId: undefined,
      })
    }

    const items = [...itemMap.values()].map(({ run: _run, ...item }) => item)
    const latest = ordered[0]
    const decided = items.filter((item) => item.status !== 'pending')
    const completed = decided.length === items.length
    const stage: ReviewBatch['stage'] = completed ? 'completed' : 'collecting'
    const frozenAt = decided[0]?.review?.reviewedAt ?? MIGRATED_AT
    const ruleSnapshots: RuleSnapshot[] = completed
      ? snapshotRules(allRules, frozenAt)
      : []
    const batch: ReviewBatch = {
      id: batchIdForKey(projectId, build),
      projectId,
      build,
      name:
        items.length === 1
          ? `${latest.page} · 单运行批次`
          : `${build} 回归批（${items.length} 个页面）`,
      stage,
      version: 1,
      ruleSnapshotId: completed ? `snapshot-${batchIdForKey(projectId, build)}-1` : '',
      ruleSnapshots,
      items,
      createdAt: ordered[ordered.length - 1].capturedAt,
      updatedAt: frozenAt,
      reviewStartedAt: completed ? frozenAt : undefined,
      completedAt: completed ? frozenAt : undefined,
    }

    for (const item of items) {
      const owner = ordered.find((run) => run.id === item.primaryRunId)
      nextRuns.push({
        ...owner!,
        status: item.status,
        review: item.review,
        batchId: batch.id,
        itemId: item.id,
        regions: item.regions,
        receivedAt: owner!.receivedAt ?? owner!.capturedAt,
      })
    }

    batches.push(batch)
  }

  // 未被任何分组消费的分片（找不到主分片）保持原样，留给后续批次
  const consumed = new Set(nextRuns.map((run) => run.id))
  for (const fragment of fragments) {
    if (!consumed.has(fragment.id)) nextRuns.push({ ...fragment })
  }

  return { batches, runs: nextRuns }
}

const seedLegacy = (): LegacyDatabase => ({ projects, runs, baselines, rules })

const migrate = (input: LegacyDatabase): Database => {
  const allRules: IgnoreRule[] = (input.rules ?? rules).map((rule) => ({
    ...rule,
    updatedAt: rule.updatedAt ?? rule.createdAt,
  }))
  const { batches, runs: migratedRuns } = buildBatchesFromLegacyRuns(input.runs ?? runs, allRules)
  const migratedBaselines = (input.baselines ?? baselines).map((baseline) => ({
    ...baseline,
    pageName: baseline.pageName ?? baseline.page,
  }))
  return {
    version: 2,
    projects: input.projects ?? projects,
    runs: migratedRuns,
    baselines: migratedBaselines,
    rules: allRules,
    batches,
    drafts: [],
    appliedMutations: [],
  }
}

let cache: Database | null = null
let initPromise: Promise<Database> | null = null
let lastPersistedAt = 0

/** 启动恢复：localStorage 优先，失败后从 IndexedDB 日志恢复，都没有则播种并迁移 */
export const initDb = async (): Promise<Database> => {
  if (cache) return cache
  if (!initPromise) {
    initPromise = (async () => {
      const loaded = await loadSnapshot<Database>()
      if (loaded.data && (loaded.data as Database).version === 2 && Array.isArray((loaded.data as Database).batches)) {
        cache = loaded.data
      } else {
        const legacy: LegacyDatabase | null = loaded.data
          ? (loaded.data as LegacyDatabase)
          : loaded.legacyRaw
            ? safeParse(loaded.legacyRaw)
            : seedLegacy()
        cache = migrate(legacy ?? seedLegacy())
        await persistSnapshot(cache, cache.appliedMutations)
      }
      if (loaded.recoveredFromJournal) {
        // localStorage 曾写入失败，恢复成功后回写主存储，下一次启动无需再走日志
        await persistSnapshot(cache, cache.appliedMutations)
      }
      return cache
    })()
  }
  return initPromise
}

const safeParse = (raw: string): LegacyDatabase | null => {
  try {
    return JSON.parse(raw) as LegacyDatabase
  } catch {
    return null
  }
}

/** 同步读取内存缓存（必须先 await initDb） */
export const readDb = (): Database => {
  if (!cache) throw new Error('数据库尚未完成初始化恢复')
  return cache
}

/**
 * 持久化：先写 IndexedDB 日志再写 localStorage。
 * localStorage 失败不丢数据——内存态继续服务，重启时由日志恢复。
 */
export const saveDb = async (db: Database): Promise<{ persisted: boolean }> => {
  cache = db
  lastPersistedAt = Date.now()
  return persistSnapshot(db, db.appliedMutations)
}

export const lastSaveAt = () => lastPersistedAt

/** 供测试与调试使用的区域指纹工具 */
export const debugRegionKey = regionKey
