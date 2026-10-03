import type {
  BatchItem,
  DifferenceRegion,
  IgnoreRule,
  ReviewBatch,
  RuleSnapshot,
  ScreenshotRun,
} from '@/types'

/** 区域几何指纹：同位置同尺寸的区域视为同一处，重算/归档时按此去重 */
export const regionKey = (region: Pick<DifferenceRegion, 'x' | 'y' | 'width' | 'height'>) =>
  `${region.x}|${region.y}|${region.width}|${region.height}`

/** 分片内容指纹：同项目同一构建同一页面维度下，重复分片只归档一次 */
export const fragmentFingerprint = (input: {
  projectId: string
  build: string
  page: string
  device: string
  theme: string
  name: string
  size: number
  fragmentIndex?: number
}) =>
  [
    input.projectId,
    input.build.trim(),
    input.page.trim(),
    input.device.trim(),
    input.theme,
    input.fragmentIndex ?? 0,
    input.name,
    input.size,
  ].join('::')

export const batchKey = (projectId: string, build: string) => `${projectId}::${build.trim()}`

export const batchIdForKey = (projectId: string, build: string) =>
  `batch-${batchKey(projectId, build).replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()}`

/** 简化 glob：支持 * 与 ?，匹配页面/设备模式 */
export const globMatch = (pattern: string, value: string): boolean => {
  const expr = pattern
    .trim()
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${expr}$`).test(value)
}

export const ruleSignature = (rule: IgnoreRule): string =>
  [
    rule.id,
    rule.name,
    rule.selector,
    rule.pagePattern,
    rule.devicePattern,
    rule.maxDelta,
    rule.enabled ? 1 : 0,
  ].join('|')

export const snapshotRules = (rules: IgnoreRule[], at = new Date().toISOString()): RuleSnapshot[] =>
  rules.map((rule) => ({
    id: rule.id,
    name: rule.name,
    selector: rule.selector,
    pagePattern: rule.pagePattern,
    devicePattern: rule.devicePattern,
    maxDelta: rule.maxDelta,
    enabled: rule.enabled,
    signature: ruleSignature(rule),
    snapshottedAt: at,
  }))

const ruleMatches = (
  snapshot: RuleSnapshot,
  context: { page: string; device: string },
) =>
  snapshot.enabled &&
  globMatch(snapshot.pagePattern, context.page) &&
  globMatch(snapshot.devicePattern, context.device)

/**
 * 用规则快照判定区域。仅在收集期 / 未批准区域重算时调用：
 * 命中规则且色差不超过 maxDelta 的环境类区域标记为规则忽略。
 * 项目级规则由调用方先过滤（snapshots 中保留全部规则以便审计）。
 */
export const applySnapshotToRegions = (
  regions: DifferenceRegion[],
  snapshots: RuleSnapshot[],
  context: { page: string; device: string },
): DifferenceRegion[] =>
  regions.map((region) => {
    if (region.pinned || region.source === 'manual') return { ...region }
    const matched = snapshots.find(
      (snapshot) =>
        snapshot.enabled &&
        globMatch(snapshot.pagePattern, context.page) &&
        globMatch(snapshot.devicePattern, context.device) &&
        (region.delta ?? 0) <= snapshot.maxDelta,
    )
    if (matched && (region.kind === 'environment' || region.ruleId === matched.id)) {
      return {
        ...region,
        ignored: true,
        ruleId: matched.id,
        decision: 'ignored' as const,
        source: 'rule' as const,
      }
    }
    return { ...region, ignored: false, ruleId: undefined, decision: 'pending' as const, source: undefined }
  })

/** 合并新分片区域：按几何指纹去重，像素取较大值，不产生重复区域 */
export const mergeFragmentRegions = (
  existing: DifferenceRegion[],
  incoming: DifferenceRegion[],
): DifferenceRegion[] => {
  const merged = new Map<string, DifferenceRegion>()
  for (const region of existing) merged.set(regionKey(region), { ...region })
  for (const region of incoming) {
    const key = regionKey(region)
    const current = merged.get(key)
    if (!current) {
      merged.set(key, { ...region })
      continue
    }
    merged.set(key, {
      ...current,
      pixels: Math.max(current.pixels, region.pixels),
      severity:
        region.pixels > current.pixels ? region.severity : current.severity,
    })
  }
  return [...merged.values()]
}

/** 收集期按当前规则实时判定区域（尚未固定快照） */
export const evaluateCollectingRegions = (
  regions: DifferenceRegion[],
  rules: IgnoreRule[],
  context: { projectId: string; page: string; device: string },
): DifferenceRegion[] => {
  const snapshots = snapshotRules(
    rules.filter((rule) => rule.projectId === 'all' || rule.projectId === context.projectId),
  )
  return applySnapshotToRegions(regions, snapshots, context)
}

/**
 * 未批准区域重算：
 * - 已批准条目 / pinned（已确认）区域 / 手工判定区域保持不动；
 * - 规则来源和待判定区域用新快照重新判定；
 * - 区域按几何指纹去重，不会因重算产生重复区域。
 */
export const recomputeItemRegions = (
  item: BatchItem,
  snapshots: RuleSnapshot[],
): { regions: DifferenceRegion[]; recomputedCount: number } => {
  if (item.status === 'approved') {
    return { regions: item.regions.map((region) => ({ ...region })), recomputedCount: 0 }
  }
  let recomputedCount = 0
  const regions = item.regions.map((region) => {
    if (region.pinned || region.source === 'manual') return { ...region }
    recomputedCount += 1
    const matched = snapshots.find((snapshot) => ruleMatches(snapshot, item))
    if (
      matched &&
      (region.delta ?? 0) <= matched.maxDelta &&
      (region.kind === 'environment' || region.ruleId === matched.id)
    ) {
      return {
        ...region,
        ignored: true,
        ruleId: matched.id,
        decision: 'ignored' as const,
        source: 'rule' as const,
      }
    }
    return { ...region, ignored: false, ruleId: undefined, decision: 'pending' as const, source: undefined }
  })
  return { regions: dedupeRegions(regions), recomputedCount }
}

export const dedupeRegions = (regions: DifferenceRegion[]): DifferenceRegion[] => {
  const map = new Map<string, DifferenceRegion>()
  for (const region of regions) {
    const key = regionKey(region)
    if (!map.has(key)) map.set(key, region)
  }
  return [...map.values()]
}

/** 当前规则相比批次进入评审时的快照是否发生过变化 */
export const snapshotIsStale = (batch: ReviewBatch, rules: IgnoreRule[]): boolean => {
  if (batch.stage === 'collecting') return false
  const snapshot = batch.ruleSnapshots
  const relevant = rules.filter((rule) =>
    snapshot.some((frozen) => frozen.id === rule.id),
  )
  if (relevant.length !== snapshot.length) return true
  return relevant.some((rule) => {
    const frozen = snapshot.find((item) => item.id === rule.id)
    return frozen ? frozen.signature !== ruleSignature(rule) : true
  })
}

export const itemMismatchRate = (item: BatchItem): number => {
  const active = item.regions.filter((region) => region.decision !== 'ignored' && !region.ignored)
  const pixels = active.reduce((sum, region) => sum + region.pixels, 0)
  return Number((pixels / 9000).toFixed(2))
}

/** 判断分片是否已在条目中归档（按 runId 与内容指纹双重判重） */
export const isFragmentArchived = (item: BatchItem | undefined, fingerprint: string, runId: string) =>
  Boolean(
    item &&
      (item.archivedFragments.some(
        (fragment) => fragment.fingerprint === fingerprint || fragment.runId === runId,
      ) ||
        item.fragmentRunIds.includes(runId)),
  )

export const runDisplayName = (run: ScreenshotRun) =>
  run.fragmentOfRunId ? `${run.name}（分片 ${run.fragmentIndex ?? ''}）` : run.name
