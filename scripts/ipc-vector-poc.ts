#!/usr/bin/env node
import pg from 'pg'
import {
  buildClassificationEmbeddingDocument,
  type ClassificationEmbeddingLocale,
} from '../lib/classification-embedding.ts'
import {
  assertClassificationEmbeddingDimensions,
  embedClassificationRows,
  upsertClassificationEmbeddings,
} from '../lib/classification-vector-search.ts'
import {
  getEmbedding,
  getEmbeddingBatchSize,
  getEmbeddingConcurrency,
} from '../lib/embedding.ts'
import type { ClassificationRow } from '../types/index.ts'

type CliOptions = {
  section: string
  limit: number
  locale: ClassificationEmbeddingLocale
  level: 'all' | 'concrete'
  model: string
  dimensions: number
  batchSize: number
  concurrency: number
  topK: number
  query?: string
  dryRun: boolean
  write: boolean
}

const DEFAULT_MODEL =
  process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small'
const DEFAULT_DIMENSIONS = Number.parseInt(
  process.env.OPENAI_EMBEDDING_DIMENSIONS || '1024',
  10,
)
const DEFAULT_BATCH_SIZE = getEmbeddingBatchSize()
const DEFAULT_CONCURRENCY = getEmbeddingConcurrency()

function parsePositiveInt(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    section: 'H',
    limit: 500,
    locale: 'mixed',
    level: 'concrete',
    model: DEFAULT_MODEL,
    dimensions: Number.isFinite(DEFAULT_DIMENSIONS) ? DEFAULT_DIMENSIONS : 1024,
    batchSize: DEFAULT_BATCH_SIZE,
    concurrency: DEFAULT_CONCURRENCY,
    topK: 10,
    dryRun: true,
    write: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = argv[index + 1]

    if (arg === '--') continue
    if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    }
    if (arg === '--write') {
      options.write = true
      options.dryRun = false
      continue
    }
    if (arg === '--dry-run') {
      options.dryRun = true
      options.write = false
      continue
    }

    if (!next || next.startsWith('--')) {
      throw new Error(`Missing value for ${arg}`)
    }

    if (arg === '--section') options.section = next.toUpperCase()
    else if (arg === '--limit') options.limit = parsePositiveInt(next, arg)
    else if (arg === '--model') options.model = next
    else if (arg === '--dimensions')
      options.dimensions = parsePositiveInt(next, arg)
    else if (arg === '--batch-size')
      options.batchSize = parsePositiveInt(next, arg)
    else if (arg === '--concurrency')
      options.concurrency = parsePositiveInt(next, arg)
    else if (arg === '--top-k') options.topK = parsePositiveInt(next, arg)
    else if (arg === '--query') options.query = next
    else if (arg === '--locale') {
      if (next !== 'mixed' && next !== 'zh' && next !== 'en') {
        throw new Error('--locale must be mixed, zh, or en')
      }
      options.locale = next
    } else if (arg === '--level') {
      if (next !== 'all' && next !== 'concrete') {
        throw new Error('--level must be all or concrete')
      }
      options.level = next
    } else {
      throw new Error(`Unknown option: ${arg}`)
    }

    index += 1
  }

  if (!/^[A-H]$/.test(options.section)) {
    throw new Error('--section must be one of A-H for IPC')
  }

  return options
}

function printHelp(): void {
  console.log(`Usage:
  pnpm vector:poc -- --section H --limit 500 --query "锂电池隔膜"
  pnpm vector:poc -- --section H --limit 500 --write

Options:
  --section <A-H>       IPC section to sample, default H
  --limit <n>           Number of IPC rows to sample, default 500
  --level <mode>        all or concrete, default concrete
  --locale <locale>     mixed, zh, or en embedding text, default mixed
  --query <text>        Run in-memory semantic search over sampled rows
  --write               Store sampled embeddings in PostgreSQL
  --dry-run             Preview sampled embedding text without API calls, default
  --model <name>        Embedding model, default OPENAI_EMBEDDING_MODEL or text-embedding-3-small
  --dimensions <n>      Embedding dimensions, default OPENAI_EMBEDDING_DIMENSIONS or 1024
  --batch-size <n>      Embedding request batch size, default OPENAI_EMBEDDING_BATCH_SIZE or 10
  --concurrency <n>     Concurrent embedding batch requests, default OPENAI_EMBEDDING_CONCURRENCY or 3
  --top-k <n>           Search result count, default 10`)
}

function getConnectionConfig(): pg.PoolConfig {
  if (process.env.DATABASE_URL)
    return { connectionString: process.env.DATABASE_URL }

  const host = process.env.CNIPA_PG_HOST
  const port = Number.parseInt(process.env.CNIPA_PG_PORT || '5432', 10)
  const database = process.env.CNIPA_PG_DB
  const user = process.env.CNIPA_PG_USER
  const password = process.env.CNIPA_PG_PASSWORD

  if (host && database && user) return { host, port, database, user, password }

  throw new Error(
    'Database is not configured. Set DATABASE_URL or CNIPA_PG_* variables.',
  )
}

async function fetchIpcRows(
  client: pg.PoolClient,
  options: CliOptions,
  skipExisting: boolean,
): Promise<ClassificationRow[]> {
  const conditions = ['ic.section = $1']
  const params: (string | number)[] = [options.section]

  if (options.level === 'concrete') {
    conditions.push('ic.main_group IS NOT NULL')
  }

  if (skipExisting) {
    params.push(options.locale, options.model, options.dimensions)
    conditions.push(`NOT EXISTS (
      SELECT 1
        FROM cnipa.classification_embedding ce
       WHERE ce.type = 'ipc'
         AND ce.code_norm = ic.code_norm
         AND ce.version = ic.version
         AND ce.locale = $${params.length - 2}
         AND ce.embedding_model = $${params.length - 1}
         AND ce.embedding_dimensions = $${params.length}
    )`)
  }

  params.push(options.limit)

  const result = await client.query<ClassificationRow>(
    `SELECT code_norm, code, source_code, version, section, class_code,
            subclass, main_group, subgroup, level, title_en, title_zh,
            title_zh_source, source_file
       FROM cnipa.ipc_classification ic
      WHERE ${conditions.join(' AND ')}
      ORDER BY ic.code_norm
      LIMIT $${params.length}`,
    params,
  )

  return result.rows
}

async function classificationEmbeddingTableExists(
  client: pg.PoolClient,
): Promise<boolean> {
  const result = await client.query<{ table_name: string | null }>(
    "SELECT to_regclass('cnipa.classification_embedding') AS table_name",
  )
  return Boolean(result.rows[0]?.table_name)
}

async function fetchIpcRowsFromPool(
  pool: pg.Pool,
  options: CliOptions,
): Promise<ClassificationRow[]> {
  const client = await pool.connect()
  try {
    if (options.write) {
      await assertClassificationEmbeddingDimensions(client, options.dimensions)
    }
    const skipExisting =
      options.write && (await classificationEmbeddingTableExists(client))
    return await fetchIpcRows(client, options, skipExisting)
  } finally {
    client.release()
  }
}

function cosineSimilarity(left: number[], right: number[]): number {
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0

  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index]
    leftNorm += left[index] * left[index]
    rightNorm += right[index] * right[index]
  }

  if (leftNorm === 0 || rightNorm === 0) return 0
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))
}

async function searchInMemory(
  embeddedRows: Awaited<ReturnType<typeof embedClassificationRows>>,
  query: string,
  options: CliOptions,
): Promise<void> {
  const queryEmbedding = await getEmbedding(query, {
    model: options.model,
    dimensions: options.dimensions,
    batchSize: options.batchSize,
    concurrency: options.concurrency,
  })
  const results = embeddedRows
    .map((item) => ({
      row: item.row,
      score: cosineSimilarity(queryEmbedding, item.embedding),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, options.topK)

  console.log(`\nQuery: ${query}`)
  for (const result of results) {
    console.log(
      `${result.score.toFixed(4)} ${result.row.code} ${result.row.title_zh || result.row.title_en}`,
    )
  }
}

function printPreview(rows: ClassificationRow[], options: CliOptions): void {
  console.log(
    `IPC vector POC preview: section=${options.section}, level=${options.level}, rows=${rows.length}, locale=${options.locale}`,
  )
  for (const row of rows.slice(0, 5)) {
    const document = buildClassificationEmbeddingDocument(
      'ipc',
      row,
      options.locale,
    )
    console.log(`\n--- ${row.code} ---`)
    console.log(document.content)
    console.log(`content_hash=${document.content_hash}`)
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const pool = new pg.Pool(getConnectionConfig())

  try {
    const rows = await fetchIpcRowsFromPool(pool, options)

    if (rows.length === 0) {
      console.log('No IPC rows matched the POC sample filter.')
      return
    }

    if (options.dryRun && !options.query) {
      printPreview(rows, options)
      return
    }

    const embeddedRows = await embedClassificationRows(rows, {
      type: 'ipc',
      locale: options.locale,
      embedding: {
        model: options.model,
        dimensions: options.dimensions,
        batchSize: options.batchSize,
        concurrency: options.concurrency,
      },
    })

    if (options.write) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await upsertClassificationEmbeddings(client, embeddedRows, {
          type: 'ipc',
          locale: options.locale,
          model: options.model,
          dimensions: options.dimensions,
        })
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
      console.log(
        `Stored ${embeddedRows.length} IPC embeddings in cnipa.classification_embedding.`,
      )
    } else {
      console.log(
        `Generated ${embeddedRows.length} IPC embeddings in memory; database was not changed.`,
      )
    }

    if (options.query) {
      await searchInMemory(embeddedRows, options.query, options)
    }
  } finally {
    await pool.end()
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(message)
  if (/model|MODEL_NOT_FOUND/i.test(message)) {
    console.error(
      'Set OPENAI_EMBEDDING_MODEL to an embedding model supported by the configured OPENAI_BASE_URL.',
    )
  }
  process.exit(1)
})
