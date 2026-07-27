import Redis, { type RedisOptions } from 'ioredis'
import type {
  ClassificationRow,
  PaginatedResponse,
  ClassificationTreeResponse,
  ClassificationTreeNode,
  ClassificationFilter,
} from '@/types'
import {
  getClassificationAncestorCodeNorms,
  getClassificationDepth,
  getClassificationParentCodeNorm,
  normalizeClassificationCodeNorm,
  splitClassificationCode,
} from './classification-code'

const HASH_KEYS: Record<'ipc' | 'cpc', string> = {
  ipc: 'classifications:ipc',
  cpc: 'classifications:cpc',
}

let cachedClient: Redis | null = null

function parseRedisUrl(url: string): RedisOptions {
  const parsed = new URL(url)
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    password: parsed.password || undefined,
    db: parsed.pathname && parsed.pathname.length > 1 ? Number(parsed.pathname.slice(1)) : 0,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  }
}

function getClient(): Redis {
  if (cachedClient) return cachedClient
  const url = process.env.REDIS_URL || 'redis://127.0.0.1:6379/0'
  const client = new Redis(parseRedisUrl(url))
  client.on('error', (err) => {
    console.error('[redis-classifications] 连接错误:', err.message)
  })
  cachedClient = client
  return client
}

export function isRedisClassificationsConfigured(): boolean {
  return (
    process.env.CLASSIFICATION_STORE === 'redis' && !!process.env.REDIS_URL
  )
}

export async function testRedisConnection(): Promise<{
  success: boolean
  error?: string
}> {
  if (!isRedisClassificationsConfigured()) {
    return { success: false, error: '未启用 Redis 分类存储（CLASSIFICATION_STORE=redis）' }
  }
  const client = getClient()
  try {
    if (client.status === 'wait' || client.status === 'end') {
      await client.connect()
    }
    const pong = await client.ping()
    if (pong !== 'PONG') {
      return { success: false, error: 'Redis 未返回 PONG' }
    }
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

function parseJsonToRow(jsonStr: string): ClassificationRow | null {
  try {
    const obj = JSON.parse(jsonStr) as Record<string, unknown>
    const code_norm = obj.code_norm as string
    if (!code_norm) return null
    const levelRaw = obj.level
    const level =
      levelRaw === undefined || levelRaw === null || levelRaw === ''
        ? null
        : Number.parseInt(String(levelRaw), 10)
    return {
      code_norm,
      code: (obj.code as string) ?? code_norm,
      source_code: (obj.source_code as string) ?? '',
      version: (obj.version as string) ?? '',
      section: (obj.section as string) ?? null,
      class_code: (obj.class_code as string) ?? null,
      subclass: (obj.subclass as string) ?? null,
      main_group: (obj.main_group as string) ?? null,
      subgroup: (obj.subgroup as string) ?? null,
      level: Number.isFinite(level) ? level : null,
      title_en: (obj.title_en as string) ?? '',
      title_zh: (obj.title_zh as string | null) ?? null,
      title_zh_source: (obj.title_zh_source as string | null) ?? null,
      source_file: (obj.source_file as string | null) ?? null,
    }
  } catch {
    return null
  }
}

type RowsCacheEntry = { rows: ClassificationRow[]; loadedAt: number }
const ALL_ROWS_TTL_MS = 5 * 60 * 1000
const rowsCache: Partial<Record<'ipc' | 'cpc', RowsCacheEntry>> = {}

async function loadAllRows(
  client: Redis,
  type: 'ipc' | 'cpc',
): Promise<ClassificationRow[]> {
  const cached = rowsCache[type]
  if (cached && Date.now() - cached.loadedAt < ALL_ROWS_TTL_MS) {
    return cached.rows
  }
  const hashData = await client.hgetall(HASH_KEYS[type])
  const rows: ClassificationRow[] = []
  for (const jsonStr of Object.values(hashData)) {
    const row = parseJsonToRow(jsonStr)
    if (row) rows.push(row)
  }
  rowsCache[type] = { rows, loadedAt: Date.now() }
  return rows
}

export function clearRedisClassificationCache(): void {
  rowsCache.ipc = undefined
  rowsCache.cpc = undefined
}

function rowMatchesQuery(row: ClassificationRow, query: string | undefined): boolean {
  if (!query) return true
  const q = query.trim()
  if (!q) return true
  let codeNormPrefix: string
  try {
    codeNormPrefix = `${normalizeClassificationCodeNorm(q)}%`
  } catch {
    codeNormPrefix = ''
  }
  const like = q.toLowerCase()
  if (
    codeNormPrefix &&
    row.code_norm.toLowerCase().startsWith(codeNormPrefix.slice(0, -1).toLowerCase())
  ) {
    return true
  }
  if (row.code.toLowerCase().includes(like)) return true
  if (row.source_code.toLowerCase().includes(like)) return true
  if (row.title_en && row.title_en.toLowerCase().includes(like)) return true
  if (row.title_zh && row.title_zh.toLowerCase().includes(like)) return true
  return false
}

function rowIsCodePrefixMatch(row: ClassificationRow, query: string | undefined): boolean {
  if (!query) return false
  let normalized: string
  try {
    normalized = normalizeClassificationCodeNorm(query)
  } catch {
    return false
  }
  return row.code_norm.toLowerCase().startsWith(normalized.toLowerCase())
}

function compareRows(
  a: ClassificationRow,
  b: ClassificationRow,
  query: string | undefined,
): number {
  if (query) {
    const aPrefix = rowIsCodePrefixMatch(a, query)
    const bPrefix = rowIsCodePrefixMatch(b, query)
    if (aPrefix !== bPrefix) return aPrefix ? -1 : 1
  }
  if (a.section && b.section && a.section !== b.section) {
    return a.section.localeCompare(b.section)
  }
  if (a.class_code && b.class_code && a.class_code !== b.class_code) {
    return a.class_code.localeCompare(b.class_code)
  }
  if (a.subclass && b.subclass && a.subclass !== b.subclass) {
    return a.subclass.localeCompare(b.subclass)
  }
  const aMg = a.main_group ? Number.parseInt(a.main_group, 10) : null
  const bMg = b.main_group ? Number.parseInt(b.main_group, 10) : null
  if (
    aMg !== null &&
    bMg !== null &&
    !Number.isNaN(aMg) &&
    !Number.isNaN(bMg) &&
    aMg !== bMg
  ) {
    return aMg - bMg
  }
  if ((a.subgroup || '') !== (b.subgroup || '')) {
    return (a.subgroup || '').localeCompare(b.subgroup || '')
  }
  return a.code_norm.localeCompare(b.code_norm)
}

export async function getClassificationListFromRedis(
  filter: ClassificationFilter,
  page = 1,
  limit = 20,
): Promise<PaginatedResponse<ClassificationRow>> {
  const normalizedPage = Math.max(1, page)
  const normalizedLimit = Math.min(Math.max(1, limit), 100)
  const client = getClient()
  if (client.status === 'wait' || client.status === 'end') {
    await client.connect()
  }
  const query = filter.q?.trim() || undefined
  const type = filter.type === 'cpc' ? 'cpc' : 'ipc'
  const rows = await loadAllRows(client, type)
  const filtered = rows.filter((row) => rowMatchesQuery(row, query))
  filtered.sort((a, b) => compareRows(a, b, query))
  const total = filtered.length
  const offset = (normalizedPage - 1) * normalizedLimit
  return {
    items: filtered.slice(offset, offset + normalizedLimit),
    total,
    page: normalizedPage,
    limit: normalizedLimit,
    total_pages: Math.ceil(total / normalizedLimit),
  }
}

function mapClassificationTreeNode(
  row: ClassificationRow,
  matches: Set<string>,
): ClassificationTreeNode {
  return {
    ...row,
    parent_code_norm: getClassificationParentCodeNorm(row.code_norm),
    depth: getClassificationDepth(row.code_norm),
    has_children: !row.main_group || row.subgroup === '00',
    is_match: matches.has(row.code_norm),
  }
}

function getChildCondition(parentCodeNorm: string | null): {
  test: (row: ClassificationRow) => boolean
} {
  if (!parentCodeNorm) {
    return {
      test: (row) => /^[A-H]$/.test(row.code_norm),
    }
  }
  let normalized: string
  try {
    normalized = normalizeClassificationCodeNorm(parentCodeNorm)
  } catch {
    return { test: () => false }
  }
  const parts = splitClassificationCode(normalized)
  if (normalized.length === 1 && parts.section) {
    return {
      test: (row) => row.section === parts.section && /^[A-Z]\d{2}$/.test(row.code_norm),
    }
  }
  if (normalized.length === 3 && parts.class_code && !parts.subclass) {
    return {
      test: (row) =>
        row.class_code === parts.class_code && /^[A-Z]\d{2}[A-Z]$/.test(row.code_norm),
    }
  }
  if (parts.subclass && !parts.main_group) {
    return {
      test: (row) =>
        row.subclass === parts.subclass && !!row.main_group && row.subgroup === '00',
    }
  }
  if (parts.subclass && parts.main_group && parts.subgroup === '00') {
    return {
      test: (row) =>
        row.subclass === parts.subclass &&
        row.main_group === parts.main_group &&
        !!row.subgroup &&
        row.subgroup !== '00',
    }
  }
  return { test: () => false }
}

export async function getClassificationTreeFromRedis(
  filter: ClassificationFilter,
  parentCodeNorm: string | null = null,
  limit = 100,
): Promise<ClassificationTreeResponse> {
  const normalizedLimit = Math.min(Math.max(1, limit), 200)
  const client = getClient()
  if (client.status === 'wait' || client.status === 'end') {
    await client.connect()
  }
  const query = filter.q?.trim()
  const type = filter.type === 'cpc' ? 'cpc' : 'ipc'
  const rows = await loadAllRows(client, type)

  if (!query) {
    const condition = getChildCondition(parentCodeNorm)
    const matched = rows.filter(condition.test)
    matched.sort((a, b) => compareRows(a, b, undefined))
    const items = matched
      .slice(0, normalizedLimit)
      .map((row) => mapClassificationTreeNode(row, new Set()))
    return {
      items,
      total: matched.length,
      limit: normalizedLimit,
      parent_code_norm: parentCodeNorm,
      is_search: false,
    }
  }

  let normalized: string
  try {
    normalized = normalizeClassificationCodeNorm(query)
  } catch {
    normalized = query.toUpperCase().replace(/\s+/g, '')
  }
  const codePrefix = normalized.toLowerCase()
  const like = query.toLowerCase()
  const matches = new Set<string>()
  const wanted = new Set<string>()
  for (const row of rows) {
    const isMatch =
      row.code_norm.toLowerCase().startsWith(codePrefix) ||
      row.code.toLowerCase().includes(like) ||
      row.source_code.toLowerCase().includes(like) ||
      (row.title_en && row.title_en.toLowerCase().includes(like)) ||
      (row.title_zh && row.title_zh.toLowerCase().includes(like))
    if (!isMatch) continue
    matches.add(row.code_norm)
    wanted.add(row.code_norm)
    for (const ancestor of getClassificationAncestorCodeNorms(row.code_norm)) {
      wanted.add(ancestor)
    }
  }

  if (wanted.size === 0) {
    return {
      items: [],
      total: 0,
      limit: normalizedLimit,
      parent_code_norm: null,
      is_search: true,
    }
  }

  const ancestorRows = rows.filter((row) => wanted.has(row.code_norm))
  ancestorRows.sort((a, b) => compareRows(a, b, undefined))
  const items = ancestorRows.map((row) => mapClassificationTreeNode(row, matches))
  return {
    items,
    total: matches.size,
    limit: normalizedLimit,
    parent_code_norm: null,
    is_search: true,
  }
}
