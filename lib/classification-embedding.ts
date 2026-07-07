import { createHash } from 'node:crypto'
import type { ClassificationRow, ClassificationType } from '@/types'

export type ClassificationEmbeddingLocale = 'en' | 'zh' | 'mixed'

export type ClassificationEmbeddingDocument = {
  type: ClassificationType
  code_norm: string
  version: string
  locale: ClassificationEmbeddingLocale
  content: string
  content_hash: string
}

function compactLine(value: string | null | undefined): string | null {
  const compacted = value?.replace(/\s+/g, ' ').trim()
  return compacted || null
}

export function getClassificationDepthLabel(row: ClassificationRow): string {
  if (row.subgroup && row.subgroup !== '00') return 'subgroup'
  if (row.main_group) return 'main_group'
  if (row.subclass) return 'subclass'
  if (row.class_code) return 'class'
  return 'section'
}

export function buildClassificationEmbeddingContent(
  row: ClassificationRow,
  type: ClassificationType,
  locale: ClassificationEmbeddingLocale = 'mixed',
): string {
  const typeLabel = type.toUpperCase()
  const lines = [
    `分类类型：${typeLabel}`,
    `分类号：${row.code}`,
    `规范分类号：${row.code_norm}`,
    `版本：${row.version}`,
    `层级：${getClassificationDepthLabel(row)}`,
  ]

  const titleZh = compactLine(row.title_zh)
  const titleEn = compactLine(row.title_en)

  if (locale !== 'en' && titleZh) lines.push(`中文标题：${titleZh}`)
  if (locale !== 'zh' && titleEn) lines.push(`英文标题：${titleEn}`)

  const structure = [
    row.section ? `section=${row.section}` : null,
    row.class_code ? `class=${row.class_code}` : null,
    row.subclass ? `subclass=${row.subclass}` : null,
    row.main_group ? `main_group=${row.main_group}` : null,
    row.subgroup ? `subgroup=${row.subgroup}` : null,
  ].filter((part): part is string => Boolean(part))

  if (structure.length > 0) lines.push(`结构字段：${structure.join(' ')}`)

  return lines.join('\n')
}

export function hashClassificationEmbeddingContent(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

export function buildClassificationEmbeddingDocument(
  type: ClassificationType,
  row: ClassificationRow,
  locale: ClassificationEmbeddingLocale = 'mixed',
): ClassificationEmbeddingDocument {
  const content = buildClassificationEmbeddingContent(row, type, locale)

  return {
    type,
    code_norm: row.code_norm,
    version: row.version,
    locale,
    content,
    content_hash: hashClassificationEmbeddingContent(content),
  }
}

export function toPgVectorLiteral(embedding: number[]): string {
  if (embedding.length === 0) {
    throw new Error('Embedding vector cannot be empty')
  }

  for (const value of embedding) {
    if (!Number.isFinite(value)) {
      throw new Error('Embedding vector contains a non-finite value')
    }
  }

  return `[${embedding.join(',')}]`
}
