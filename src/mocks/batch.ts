import type {
  DifferenceRegion,
  IgnoreRule,
  RegionState,
  ReviewBatch,
  ScreenshotRun,
} from '@/types'

// ---- 批次自然键：同项目 + 同构建 + 同页面 + 同设备 + 同主题 ----
export const batchKeyOf = (
  scope: Pick<ScreenshotRun, 'projectId' | 'build' | 'page' | 'device' | 'theme'>,
): string =>
  [scope.projectId, scope.build, scope.page, scope.device, scope.theme]
    .map((part) => encodeURIComponent(part.trim()))
    .join('|')

// ---- 分片自然键：执行机 + 分片序号；同批次内相同分片只归档一次 ----
export const shardKeyOf = (run: Pick<ScreenshotRun, 'executor' | 'shardIndex' | 'id'>): string =>
  `${run.executor ?? 'executor-default'}#${run.shardIndex ?? 0}`

// ---- glob 匹配：* 通配 ----
const globMatch = (pattern: string, value: string): boolean => {
  const p = (pattern || '*').trim()
  if (!p || p === '*') return true
  const escaped = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`).test(value)
}

export const ruleApplies = (
  rule: IgnoreRule,
  scope: { projectId: string; page: string; device: string },
): boolean =>
  rule.enabled &&
  (rule.projectId === 'all' || rule.projectId === scope.projectId) &&
  globMatch(rule.pagePattern, scope.page) &&
  globMatch(rule.devicePattern, scope.device)

// 区域带选择器时按选择器命中规则；否则以 maxDelta（本模拟数据中映射为 pixels 阈值）兜底
export const matchRuleForRegion = (
  region: DifferenceRegion,
  rules: IgnoreRule[],
  scope: { projectId: string; page: string; device: string },
): IgnoreRule | undefined => {
  const applicable = rules.filter((rule) => ruleApplies(rule, scope))
  if (region.selector) {
    return applicable.find((rule) => rule.selector === region.selector)
  }
  return applicable.find(
    (rule) => region.kind === 'environment' && region.pixels <= rule.maxDelta * 20,
  )
}

// 规则快照内容哈希：规则增删改或启停都会变化
export const hashRules = (rules: IgnoreRule[]): string => {
  const body = JSON.stringify(
    rules
      .map((rule) => [
        rule.id,
        rule.enabled,
        rule.selector,
        rule.projectId,
        rule.pagePattern,
        rule.devicePattern,
        rule.maxDelta,
      ])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  )
  let hash = 0
  for (let i = 0; i < body.length; i += 1) {
    hash = (hash * 31 + body.charCodeAt(i)) | 0
  }
  return `rh-${(hash >>> 0).toString(36)}`
}

// ---- 区域判定 ----
export const regionEntryId = (runId: string, regionId: string): string => `${runId}::${regionId}`

export const parseRegionEntryId = (entryId: string): { runId: string; regionId: string } => {
  const index = entryId.indexOf('::')
  return { runId: entryId.slice(0, index), regionId: entryId.slice(index + 2) }
}

/**
 * 依据规则快照对「未确认」区域做增量判定。
 * - confirmed 区域（人工忽略/恢复 + 已批准轮次冻结）原样保留
 * - pending 区域按当前快照重新计算，保证晚到分片或规则变化后只重算未批准部分
 */
export const evaluateRegions = (
  states: RegionState[],
  runs: ScreenshotRun[],
  rules: IgnoreRule[],
  round: number,
): RegionState[] => {
  const runById = new Map(runs.map((run) => [run.id, run]))
  const next: RegionState[] = []
  const seen = new Set<string>()

  for (const state of states) {
    seen.add(regionEntryId(state.runId, state.regionId))
    if (state.state === 'confirmed') {
      next.push({ ...state })
      continue
    }
    const run = runById.get(state.runId)
    const region = run?.regions.find((item) => item.id === state.regionId)
    if (!run || !region) {
      // 分片数据尚未到达，保留挂起判定
      next.push({ ...state, round })
      continue
    }
    const matched = matchRuleForRegion(region, rules, {
      projectId: run.projectId,
      page: run.page,
      device: run.device,
    })
    next.push({
      runId: state.runId,
      regionId: state.regionId,
      ignored: Boolean(matched),
      ruleId: matched?.id,
      manual: false,
      state: 'pending',
      round,
    })
  }

  // 新分片带来的新区域：初始为 pending 并按快照判定
  for (const run of runs) {
    for (const region of run.regions) {
      const entryId = regionEntryId(run.id, region.id)
      if (seen.has(entryId)) continue
      seen.add(entryId)
      const matched = matchRuleForRegion(region, rules, {
        projectId: run.projectId,
        page: run.page,
        device: run.device,
      })
      next.push({
        runId: run.id,
        regionId: region.id,
        ignored: Boolean(matched),
        ruleId: matched?.id,
        manual: false,
        state: 'pending',
        round,
      })
    }
  }

  return next
}

// 快照取批次某一轮冻结的规则；找不到时回退最新快照
export const rulesOfRound = (batch: ReviewBatch, round: number): IgnoreRule[] => {
  const batchRound = batch.rounds.find((item) => item.round === round)
  const snapshot =
    batch.snapshots.find((item) => item.id === batchRound?.snapshotId) ??
    [...batch.snapshots].sort((a, b) => b.takenAt.localeCompare(a.takenAt))[0]
  return snapshot ? snapshot.rules : []
}
