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

export async function ensureClassificationEmbeddingTable(
  client: pg.PoolClient,
  dimensions: number,
): Promise<void> {
  if (!Number.isFinite(dimensions) || dimensions <= 0) {
    throw new Error('embedding dimensions 必须是正整数')
  }

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
      embedding            VECTOR(${Math.trunc(dimensions)}) NOT NULL,
      embedded_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (type, code_norm, version, locale, embedding_model)
    )
  `)
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
  const dimensions = options.dimensions ?? embeddedRows[0].embedding.length

  await ensureClassificationEmbeddingTable(client, dimensions)

  for (const item of embeddedRows) {
    await client.query(
      `INSERT INTO ${CLASSIFICATION_EMBEDDING_TABLE} (
         type, code_norm, version, locale, embedding_model,
         embedding_dimensions, content_hash, content, embedding
       )
       VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9::vector
       )
       ON CONFLICT (type, code_norm, version, locale, embedding_model)
       DO UPDATE SET
         embedding_dimensions = EXCLUDED.embedding_dimensions,
         content_hash = EXCLUDED.content_hash,
         content = EXCLUDED.content,
         embedding = EXCLUDED.embedding,
         embedded_at = CURRENT_TIMESTAMP`,
      [
        options.type,
        item.row.code_norm,
        item.row.version,
        locale,
        model,
        dimensions,
        item.content_hash,
        item.content,
        toPgVectorLiteral(item.embedding),
      ],
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
  const limit = normalizeLimit(options.limit)
  const section = normalizeSection(options.section)

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
  })

  return searchSimilarClassificationsByEmbedding(
    client,
    queryEmbedding,
    options,
  )
}
