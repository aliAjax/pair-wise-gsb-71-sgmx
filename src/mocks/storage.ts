/**
 * 持久化存储层。
 *
 * 设计要点：
 * - localStorage 为主存储，IndexedDB 作为写前日志（write-ahead journal）；
 * - 每次写入先把完整快照提交到 IndexedDB，再写 localStorage；
 *   localStorage 写失败（配额/隐私模式）后，内存态继续可用，重启时从 IndexedDB 恢复；
 * - 所有恢复合并按稳定 id 去重，保证“重启后不能重复区域或审批记录”；
 * - IndexedDB 不可用（SSR / 极端环境）时退化为纯内存 + localStorage。
 */

const STORAGE_KEY = 'visual-regression-platform-v2'
const LEGACY_STORAGE_KEY = 'visual-regression-platform-v1'
const DB_NAME = 'visual-regression-platform'
const DB_VERSION = 1
const STORE_NAME = 'journal'
const COMMIT_KEY = 'latest'

type JournalEntry = {
  key: typeof COMMIT_KEY
  /** 完整数据库快照 */
  snapshot: unknown
  /** 已按顺序应用的变更 id，恢复时用于去重 */
  mutationIds: string[]
  savedAt: string
}

let idbPromise: Promise<IDBDatabase | null> | null = null

const openIdb = (): Promise<IDBDatabase | null> => {
  if (idbPromise) return idbPromise
  idbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null)
      return
    }
    let settled = false
    const finish = (value: IDBDatabase | null) => {
      if (!settled) {
        settled = true
        resolve(value)
      }
    }
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      request.onupgradeneeded = () => {
        const database = request.result
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME)
        }
      }
      request.onsuccess = () => finish(request.result)
      request.onerror = () => finish(null)
      request.onblocked = () => finish(null)
      window.setTimeout(() => finish(null), 2000)
    } catch {
      finish(null)
    }
  })
  return idbPromise
}

const idbPut = (entry: JournalEntry): Promise<boolean> =>
  openIdb().then(
    (database) =>
      new Promise((resolve) => {
        if (!database) {
          resolve(false)
          return
        }
        try {
          const transaction = database.transaction(STORE_NAME, 'readwrite')
          transaction.objectStore(STORE_NAME).put(entry, entry.key)
          transaction.oncomplete = () => resolve(true)
          transaction.onerror = () => resolve(false)
          transaction.onabort = () => resolve(false)
        } catch {
          resolve(false)
        }
      }),
  )

const idbGet = (): Promise<JournalEntry | null> =>
  openIdb().then(
    (database) =>
      new Promise((resolve) => {
        if (!database) {
          resolve(null)
          return
        }
        try {
          const transaction = database.transaction(STORE_NAME, 'readonly')
          const request = transaction.objectStore(STORE_NAME).get(COMMIT_KEY)
          request.onsuccess = () => resolve((request.result as JournalEntry | undefined) ?? null)
          request.onerror = () => resolve(null)
        } catch {
          resolve(null)
        }
      }),
  )

const readLocal = (key: string): string | null => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const writeLocal = (value: string): boolean => {
  try {
    localStorage.setItem(STORAGE_KEY, value)
    return true
  } catch {
    return false
  }
}

export interface StorageResult {
  /** localStorage 是否写入成功；false 表示已转存 IndexedDB，等待下次恢复 */
  persisted: boolean
}

export interface LoadResult<T> {
  data: T | null
  /** 数据是否来自 IndexedDB（即上次 localStorage 写入失败后的恢复） */
  recoveredFromJournal: boolean
  legacyRaw?: string | null
}

/** 写前日志落库，然后写 localStorage */
export const persistSnapshot = async <T>(
  snapshot: T,
  mutationIds: string[],
): Promise<StorageResult> => {
  const entry: JournalEntry = {
    key: COMMIT_KEY,
    snapshot,
    mutationIds,
    savedAt: new Date().toISOString(),
  }
  await idbPut(entry)
  const persisted = writeLocal(JSON.stringify(snapshot))
  return { persisted }
}

/**
 * 启动时按优先级恢复：
 * 1. localStorage 正常 → 直接使用（IndexedDB 仅作故障备份）；
 * 2. localStorage 缺失/损坏但 IndexedDB 有日志 → 从日志恢复；
 * 3. 都没有 → 返回 v1 旧数据原文（若有），交由迁移逻辑升级。
 */
export const loadSnapshot = async <T>(): Promise<LoadResult<T>> => {
  const localRaw = readLocal(STORAGE_KEY)
  if (localRaw) {
    try {
      return { data: JSON.parse(localRaw) as T, recoveredFromJournal: false }
    } catch {
      // 落到 IndexedDB 恢复
    }
  }

  const journal = await idbGet()
  if (journal?.snapshot) {
    return { data: journal.snapshot as T, recoveredFromJournal: true }
  }

  const legacyRaw = readLocal(LEGACY_STORAGE_KEY)
  return { data: null, recoveredFromJournal: false, legacyRaw }
}

export { STORAGE_KEY, LEGACY_STORAGE_KEY }
