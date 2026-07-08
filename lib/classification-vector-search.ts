import type pg from 'pg'
import {
  buildClassificationEmbeddingDocument,
  toPgVectorLiteral,
  type ClassificationEmbeddingLocale,
} from './classification-embedding.ts'
import {
  getEmbedding,
  getEmbeddingModel,
  getEmbeddings,
  type EmbeddingClientOptions,
} from './embedding.ts'
import type { ClassificationRow, ClassificationType } from '@/types'

export type EmbeddedClassificationRow = {
  row: ClassificationRow
  content: string
  content_hash: string
  embedding: number[]
}

export type ClassificationSemanticSearchOptions = {
  type: ClassificationType
  query: string
  locale?: ClassificationEmbeddingLocale
  model?: string
  dimensions?: number
  limit?: number
  version?: string
  section?: string
}

export type ClassificationSemanticSearchResult = ClassificationRow & {
  similarity: number
  similarity_percent: string
  embedding_model: string
  embedding_locale: ClassificationEmbeddingLocale
  embedding_dimensions: number
  content_hash: string
}

const CLASSIFICATION_EMBEDDING_TABLE = 'cnipa.classification_embedding'
const UPSERT_CHUNK_SIZE = 200

function getClassificationTableName(type: ClassificationType): string {
  return type === 'ipc'
    ? 'cnipa.ipc_classification'
    : 'cnipa.cpc_classification'
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 10
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error('limit 必须是正整数')
  }
  return Math.min(Math.trunc(limit), 100)
}

function normalizeSection(section: string | undefined): string | undefined {
  const normalized = section?.trim().toUpperCase()
  if (!normalized) return undefined
  if (!/^[A-Z]$/.test(normalized)) {
    throw new Error('section 必须是单个大写字母')
  }
  return normalized
}

function normalizeDimensions(dimensions: number): number {
  if (!Number.isFinite(dimensions) || dimensions <= 0) {
    throw new Error('embedding dimensions 必须是正整数')
  }
  return Math.trunc(dimensions)
}

function getVectorDimensionFromType(embeddingType: string): number | null {
  const match = embeddingType.match(/^vector\((\d+)\)$/i)
  return match ? Number.parseInt(match[1], 10) : null
}

export async function getClassificationEmbeddingDimensions(
  client: pg.PoolClient,
): Promise<number | null> {
  const typeResult = await client.query<{ embedding_type: string }>(
    `SELECT format_type(a.atttypid, a.atttypmod) AS embedding_type
       FROM pg_attribute a
      WHERE a.attrelid = to_regclass($1)
        AND a.attname = 'embedding'
        AND NOT a.attisdropped`,
    [CLASSIFICATION_EMBEDDING_TABLE],
  )

  return getVectorDimensionFromType(typeResult.rows[0]?.embedding_type ?? '')
}

export async function assertClassificationEmbeddingDimensions(
  client: pg.PoolClient,
  dimensions: number,
): Promise<void> {
  const normalizedDimensions = normalizeDimensions(dimensions)
  const existingDimensions = await getClassificationEmbeddingDimensions(client)

  if (
    existingDimensions !== null &&
    existingDimensions !== normalizedDimensions
  ) {
    throw new Error(
      `classification_embedding.embedding 已是 ${existingDimensions} 维，不能写入 ${normalizedDimensions} 维向量`,
    )
  }
}

function assertEmbeddedRowsDimensions(
  embeddedRows: EmbeddedClassificationRow[],
  dimensions: number,
): void {
  for (const item of embeddedRows) {
    if (item.embedding.length !== dimensions) {
      throw new Error(
        `embedding 维度不一致：${item.row.code_norm} 为 ${item.embedding.length} 维，期望 ${dimensions} 维`,
      )
    }
  }
}

export async function ensureClassificationEmbeddingTable(
  client: pg.PoolClient,
  dimensions: number,
): Promise<void> {
  const normalizedDimensions = normalizeDimensions(dimensions)

  await client.query('CREATE EXTENSION IF NOT EXISTS vector')
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${CLASSIFICATION_EMBEDDING_TABLE} (
      type                 TEXT NOT NULL,
      code_norm            TEXT NOT NULL,
      version              TEXT NOT NULL,
      locale               TEXT NOT NULL,
      embedding_model      TEXT NOT NULL,
      embedding_dimensions INTEGER NOT NULL,
      content_hash         TEXT NOT NULL,
      content              TEXT NOT NULL,
      embedding            VECTOR(${normalizedDimensions}) NOT NULL,
      embedded_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (type, code_norm, version, locale, embedding_model)
    )
  `)

  await assertClassificationEmbeddingDimensions(client, normalizedDimensions)

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_classification_embedding_hnsw
      ON ${CLASSIFICATION_EMBEDDING_TABLE}
   USING hnsw (embedding vector_cosine_ops)
  `)
}

export async function embedClassificationRows(
  rows: ClassificationRow[],
  options: {
    type: ClassificationType
    locale?: ClassificationEmbeddingLocale
    embedding?: EmbeddingClientOptions
  },
): Promise<EmbeddedClassificationRow[]> {
  if (rows.length === 0) return []

  const locale = options.locale ?? 'mixed'
  const documents = rows.map((row) =>
    buildClassificationEmbeddingDocument(options.type, row, locale),
  )
  const embeddings = await getEmbeddings(
    documents.map((document) => document.content),
    options.embedding,
  )

  return rows.map((row, index) => ({
    row,
    content: documents[index].content,
    content_hash: documents[index].content_hash,
    embedding: embeddings[index],
  }))
}

export async function upsertClassificationEmbeddings(
  client: pg.PoolClient,
  embeddedRows: EmbeddedClassificationRow[],
  options: {
    type: ClassificationType
    locale?: ClassificationEmbeddingLocale
    model?: string
    dimensions?: number
  },
): Promise<void> {
  if (embeddedRows.length === 0) return

  const locale = options.locale ?? 'mixed'
  const model = getEmbeddingModel(options.model)
  const dimensions = normalizeDimensions(
    options.dimensions ?? embeddedRows[0].embedding.length,
  )
  assertEmbeddedRowsDimensions(embeddedRows, dimensions)

  await ensureClassificationEmbeddingTable(client, dimensions)

  for (
    let offset = 0;
    offset < embeddedRows.length;
    offset += UPSERT_CHUNK_SIZE
  ) {
    const chunk = embeddedRows.slice(offset, offset + UPSERT_CHUNK_SIZE)
    const params: (string | number)[] = []
    const valueGroups = chunk.map((item, rowIndex) => {
      params.push(
        options.type,
        item.row.code_norm,
        item.row.version,
        locale,
        model,
        dimensions,
        item.content_hash,
        item.content,
        toPgVectorLiteral(item.embedding),
      )
      const base = rowIndex * 9
      const placeholders = Array.from({ length: 9 }, (_, colIndex) => {
        const param = `$${base + colIndex + 1}`
        return colIndex === 8 ? `${param}::vector` : param
      })
      return `(${placeholders.join(', ')})`
    })

    await client.query(
      `INSERT INTO ${CLASSIFICATION_EMBEDDING_TABLE} (
         type, code_norm, version, locale, embedding_model,
         embedding_dimensions, content_hash, content, embedding
       )
       VALUES ${valueGroups.join(', ')}
       ON CONFLICT (type, code_norm, version, locale, embedding_model)
       DO UPDATE SET
         embedding_dimensions = EXCLUDED.embedding_dimensions,
         content_hash = EXCLUDED.content_hash,
         content = EXCLUDED.content,
         embedding = EXCLUDED.embedding,
         embedded_at = CURRENT_TIMESTAMP`,
      params,
    )
  }
}

export async function searchSimilarClassificationsByEmbedding(
  client: pg.PoolClient,
  queryEmbedding: number[],
  options: Omit<ClassificationSemanticSearchOptions, 'query'>,
): Promise<ClassificationSemanticSearchResult[]> {
  const type = options.type
  const tableName = getClassificationTableName(type)
  const locale = options.locale ?? 'mixed'
  const model = getEmbeddingModel(options.model)
  const queryDimensions = normalizeDimensions(queryEmbedding.length)
  const dimensions = options.dimensions
    ? normalizeDimensions(options.dimensions)
    : queryDimensions
  const limit = normalizeLimit(options.limit)
  const section = normalizeSection(options.section)
  if (queryDimensions !== dimensions) {
    throw new Error(
      `query embedding 为 ${queryDimensions} 维，期望 ${dimensions} 维`,
    )
  }

  const params: (string | number)[] = [
    toPgVectorLiteral(queryEmbedding),
    type,
    locale,
    model,
  ]
  const conditions = [
    'ce.type = $2',
    'ce.locale = $3',
    'ce.embedding_model = $4',
  ]

  if (options.version) {
    params.push(options.version)
    conditions.push(`ce.version = $${params.length}`)
  }

  params.push(dimensions)
  conditions.push(`ce.embedding_dimensions = $${params.length}`)

  if (section) {
    params.push(section)
    conditions.push(`c.section = $${params.length}`)
  }

  params.push(limit)

  const result = await client.query<
    ClassificationRow & {
      similarity: number
      embedding_model: string
      embedding_locale: ClassificationEmbeddingLocale
      embedding_dimensions: number
      content_hash: string
    }
  >(
    `SELECT c.code_norm, c.code, c.source_code, c.version, c.section,
            c.class_code, c.subclass, c.main_group, c.subgroup, c.level,
            c.title_en, c.title_zh, c.title_zh_source, c.source_file,
            ce.embedding_model,
            ce.locale AS embedding_locale,
            ce.embedding_dimensions,
            ce.content_hash,
            1 - (ce.embedding <=> $1::vector) AS similarity
       FROM ${CLASSIFICATION_EMBEDDING_TABLE} ce
       JOIN ${tableName} c
         ON c.code_norm = ce.code_norm
        AND c.version = ce.version
      WHERE ${conditions.join(' AND ')}
      ORDER BY ce.embedding <=> $1::vector
      LIMIT $${params.length}`,
    params,
  )

  return result.rows.map((row) => ({
    ...row,
    similarity: Number(row.similarity),
    similarity_percent: `${(Number(row.similarity) * 100).toFixed(1)}%`,
  }))
}

export async function searchSimilarClassifications(
  client: pg.PoolClient,
  options: ClassificationSemanticSearchOptions,
): Promise<ClassificationSemanticSearchResult[]> {
  const query = options.query.trim()
  if (!query) throw new Error('query 不能为空')

  const queryEmbedding = await getEmbedding(query, {
    model: options.model,
    dimensions: options.dimensions,
  })

  return searchSimilarClassificationsByEmbedding(
    client,
    queryEmbedding,
    options,
  )
}
