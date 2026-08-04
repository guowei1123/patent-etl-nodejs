import { normalizeClassificationCodeNorm } from './classification-code'
import type { ParsedPatent } from '@/types'

/**
 * 从环境变量加载 IPC 白名单（逗号分隔）
 * 读取 PATENT_FILTER_IPC_WHITELIST
 */
function loadIpcWhitelist(): string[] {
  const raw = process.env.PATENT_FILTER_IPC_WHITELIST
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((code) => {
      try {
        return normalizeClassificationCodeNorm(code)
      } catch {
        return code.toUpperCase().replace(/\s+/g, '')
      }
    })
}

/**
 * 从环境变量加载实体白名单（逗号分隔）
 * 读取 PATENT_FILTER_ENTITY_WHITELIST
 */
function loadEntityWhitelist(): string[] {
  const raw = process.env.PATENT_FILTER_ENTITY_WHITELIST
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.toLowerCase())
}

export const IPC_WHITELIST: string[] = loadIpcWhitelist()
export const ENTITY_WHITELIST: string[] = loadEntityWhitelist()

/**
 * 检查专利的 IPC 分类号是否在白名单范围内
 * 匹配规则：专利的任一 IPC 分类号标准化后，与白名单中的任一 code 精确匹配（含层级分组码前缀匹配）
 * 例如白名单 H01M1 匹配专利 H01M1，但不匹配 H01M10
 */
export function matchesIpcWhitelist(patent: ParsedPatent): boolean {
  const ipcCodes = patent.ipc_structured || patent.ipc_codes || []
  if (ipcCodes.length === 0) return false

  const whitelistSet = new Set(IPC_WHITELIST)

  for (const ipcCode of ipcCodes) {
    let normalized: string
    try {
      normalized = normalizeClassificationCodeNorm(ipcCode)
    } catch {
      normalized = ipcCode.toUpperCase().replace(/\s+/g, '')
    }

    // 精确匹配
    if (whitelistSet.has(normalized)) {
      return true
    }

    // 层级分组码匹配：白名单 code 匹配专利 IPC 的分组级别
    // 例如白名单 H01M10 匹配专利 H01M10/0525（斜杠后是细分层级）
    const slashIndex = normalized.indexOf('/')
    if (slashIndex > 0) {
      const groupCode = normalized.substring(0, slashIndex)
      if (whitelistSet.has(groupCode)) {
        return true
      }
    }
  }

  return false
}

/**
 * 检查专利的申请人/发明人/专利权人是否在白名单范围内
 * 匹配规则：任一实体名称（大小写不敏感）包含白名单中的任一关键词
 */
export function matchesEntityWhitelist(patent: ParsedPatent): boolean {
  const entities: string[] = []

  // 申请人
  if (patent.applicants_structured) {
    for (const applicant of patent.applicants_structured) {
      if (applicant.name) entities.push(applicant.name.toLowerCase())
    }
  }
  if (patent.applicant) entities.push(patent.applicant.toLowerCase())

  // 发明人
  if (patent.inventors_structured) {
    for (const inventor of patent.inventors_structured) {
      entities.push(inventor.toLowerCase())
    }
  }
  if (patent.inventors) {
    for (const inventor of patent.inventors) {
      entities.push(inventor.toLowerCase())
    }
  }

  // 专利权人/受让人
  if (patent.assignees) {
    for (const assignee of patent.assignees) {
      if (assignee.name) entities.push(assignee.name.toLowerCase())
    }
  }
  if (patent.assignee) entities.push(patent.assignee.toLowerCase())

  if (entities.length === 0) return false

  for (const entity of entities) {
    for (const keyword of ENTITY_WHITELIST) {
      if (entity.includes(keyword)) {
        return true
      }
    }
  }

  return false
}

/**
 * 检查专利是否符合过滤条件（IPC 或 实体 满足其一即可）
 */
export function passesFilter(patent: ParsedPatent): boolean {
  return matchesIpcWhitelist(patent) || matchesEntityWhitelist(patent)
}

/**
 * 过滤专利列表，只保留符合条件的
 */
export function filterPatents(patents: ParsedPatent[]): {
  filtered: ParsedPatent[]
  skipped: number
  ipcMatched: number
  entityMatched: number
  bothMatched: number
} {
  const filtered: ParsedPatent[] = []
  let ipcMatched = 0
  let entityMatched = 0
  let bothMatched = 0

  for (const patent of patents) {
    const ipcOk = matchesIpcWhitelist(patent)
    const entityOk = matchesEntityWhitelist(patent)

    if (ipcOk || entityOk) {
      filtered.push(patent)
      if (ipcOk && entityOk) {
        bothMatched++
      } else if (ipcOk) {
        ipcMatched++
      } else {
        entityMatched++
      }
    }
  }

  return {
    filtered,
    skipped: patents.length - filtered.length,
    ipcMatched,
    entityMatched,
    bothMatched,
  }
}
