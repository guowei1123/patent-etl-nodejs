#!/usr/bin/env node
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'
import * as yauzl from 'yauzl'
import {
  normalizeCpcClassificationCode,
  normalizeIpcClassificationCode,
  type NormalizedClassificationCode,
} from '../lib/classification-code.ts'

type TextEntry = {
  sourceFile: string
  content: string
}

type ClassificationRow = NormalizedClassificationCode & {
  source_code: string
  version: string
  level: number | null
  title_en: string
  title_zh: string | null
  title_zh_source: string | null
  source_file: string
}

type CliOptions = {
  ipcSource?: string
  cpcSource?: string
  ipcVersion: string
  cpcVersion: string
  dryRun: boolean
}

const DEFAULT_IPC_VERSION = '2026.01'
const DEFAULT_CPC_VERSION = '2026.05'
const INSERT_COLUMNS = [
  'code_norm',
  'code',
  'source_code',
  'version',
  'section',
  'class_code',
  'subclass',
  'main_group',
  'subgroup',
  'level',
  'title_en',
  'title_zh',
  'title_zh_source',
  'source_file',
]

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    ipcVersion: DEFAULT_IPC_VERSION,
    cpcVersion: DEFAULT_CPC_VERSION,
    dryRun: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = argv[index + 1]

    if (arg === '--') continue

    if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    }

    if (arg === '--dry-run') {
      options.dryRun = true
      continue
    }

    if (!next || next.startsWith('--')) {
      throw new Error(`Missing value for ${arg}`)
    }

    if (arg === '--ipc-source') options.ipcSource = next
    else if (arg === '--cpc-source') options.cpcSource = next
    else if (arg === '--ipc-version') options.ipcVersion = next
    else if (arg === '--cpc-version') options.cpcVersion = next
    else throw new Error(`Unknown option: ${arg}`)

    index += 1
  }

  if (!options.ipcSource && !options.cpcSource) {
    throw new Error('Provide --ipc-source, --cpc-source, or both')
  }

  return options
}

function printHelp(): void {
  console.log(`Usage:
  pnpm import:classifications -- --ipc-source <path-or-url> --cpc-source <path-or-url>

Options:
  --ipc-source <path-or-url>   IPC title list zip, directory, txt file, or URL
  --cpc-source <path-or-url>   CPC title list zip, directory, txt file, or URL
  --ipc-version <version>      IPC version label, default ${DEFAULT_IPC_VERSION}
  --cpc-version <version>      CPC version label, default ${DEFAULT_CPC_VERSION}
  --dry-run                    Parse and report counts without writing PostgreSQL`)
}

function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

async function downloadToTempFile(url: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`)
  }

  const fileName = path.basename(new URL(url).pathname) || 'classification.zip'
  const tempPath = path.join(os.tmpdir(), `${Date.now()}-${fileName}`)
  const body = Buffer.from(await response.arrayBuffer())
  await fs.writeFile(tempPath, body)
  return tempPath
}

async function listTextFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(dir, entry.name)
      if (entry.isDirectory()) return listTextFiles(entryPath)
      return entry.isFile() && entry.name.toLowerCase().endsWith('.txt')
        ? [entryPath]
        : []
    }),
  )
  return files.flat()
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  return new Promise((resolve, reject) => {
    stream.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    stream.on('error', reject)
    stream.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

async function readZipTextEntries(zipPath: string): Promise<TextEntry[]> {
  return new Promise((resolve, reject) => {
    const entries: TextEntry[] = []
    yauzl.open(zipPath, { lazyEntries: true }, (openError, zipfile) => {
      if (openError || !zipfile) {
        reject(openError ?? new Error(`Cannot open zip: ${zipPath}`))
        return
      }

      zipfile.readEntry()
      zipfile.on('entry', (entry: yauzl.Entry) => {
        if (/\/$/.test(entry.fileName) || !entry.fileName.endsWith('.txt')) {
          zipfile.readEntry()
          return
        }

        zipfile.openReadStream(entry, async (streamError, stream) => {
          if (streamError || !stream) {
            reject(streamError ?? new Error(`Cannot read ${entry.fileName}`))
            return
          }

          try {
            const content = (await streamToBuffer(stream)).toString('utf8')
            entries.push({ sourceFile: entry.fileName, content })
            zipfile.readEntry()
          } catch (error) {
            reject(error)
          }
        })
      })
      zipfile.on('end', () => resolve(entries))
      zipfile.on('error', reject)
    })
  })
}

async function loadTextEntries(source: string): Promise<TextEntry[]> {
  const localPath = isUrl(source) ? await downloadToTempFile(source) : source
  const stats = await fs.stat(localPath)

  if (stats.isDirectory()) {
    const files = await listTextFiles(localPath)
    return Promise.all(
      files.map(async (file) => ({
        sourceFile: path.relative(localPath, file),
        content: await fs.readFile(file, 'utf8'),
      })),
    )
  }

  if (localPath.toLowerCase().endsWith('.zip')) {
    return readZipTextEntries(localPath)
  }

  return [
    {
      sourceFile: path.basename(localPath),
      content: await fs.readFile(localPath, 'utf8'),
    },
  ]
}

function parseIpcEntries(
  entries: TextEntry[],
  version: string,
): ClassificationRow[] {
  return entries.flatMap((entry) =>
    entry.content
      .split(/\r?\n/)
      .map((line, lineIndex) =>
        parseIpcLine(line, entry.sourceFile, lineIndex + 1, version),
      )
      .filter((row): row is ClassificationRow => row !== null),
  )
}

function parseIpcLine(
  line: string,
  sourceFile: string,
  lineNumber: number,
  version: string,
): ClassificationRow | null {
  if (!line.trim()) return null

  const [sourceCode, ...titleParts] = line.split('\t')
  const title = titleParts.join('\t').trim()
  if (!sourceCode || !title) return null

  try {
    return {
      ...normalizeIpcClassificationCode(sourceCode),
      source_code: sourceCode.trim(),
      version,
      level: null,
      title_en: title,
      title_zh: null,
      title_zh_source: null,
      source_file: sourceFile,
    }
  } catch (error) {
    throw new Error(
      `Invalid IPC row ${sourceFile}:${lineNumber}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

function parseCpcEntries(
  entries: TextEntry[],
  version: string,
): ClassificationRow[] {
  return entries.flatMap((entry) =>
    entry.content
      .split(/\r?\n/)
      .map((line, lineIndex) =>
        parseCpcLine(line, entry.sourceFile, lineIndex + 1, version),
      )
      .filter((row): row is ClassificationRow => row !== null),
  )
}

function parseCpcLine(
  line: string,
  sourceFile: string,
  lineNumber: number,
  version: string,
): ClassificationRow | null {
  if (!line.trim()) return null

  const parts = line.split('\t')
  const sourceCode = parts[0]?.trim()
  const maybeLevel = parts[1]?.trim()
  const hasLevel = maybeLevel !== undefined && /^\d+$/.test(maybeLevel)
  const title = parts
    .slice(hasLevel ? 2 : 1)
    .join('\t')
    .trim()
  if (!sourceCode || !title) return null

  try {
    return {
      ...normalizeCpcClassificationCode(sourceCode),
      source_code: sourceCode,
      version,
      level: hasLevel ? Number.parseInt(maybeLevel, 10) : null,
      title_en: title,
      title_zh: null,
      title_zh_source: null,
      source_file: sourceFile,
    }
  } catch (error) {
    throw new Error(
      `Invalid CPC row ${sourceFile}:${lineNumber}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

function mergeTitle(currentTitle: string, nextTitle: string): string {
  const titles = currentTitle
    .split('; ')
    .map((title) => title.trim())
    .filter(Boolean)
  if (!titles.includes(nextTitle)) titles.push(nextTitle)
  return titles.join('; ')
}

function dedupeRows(rows: ClassificationRow[]): ClassificationRow[] {
  const byCodeNorm = new Map<string, ClassificationRow>()

  for (const row of rows) {
    const current = byCodeNorm.get(row.code_norm)
    if (!current) {
      byCodeNorm.set(row.code_norm, row)
      continue
    }

    byCodeNorm.set(row.code_norm, {
      ...current,
      title_en: mergeTitle(current.title_en, row.title_en),
    })
  }

  return [...byCodeNorm.values()]
}

function logDedupe(
  label: string,
  parsedCount: number,
  rows: ClassificationRow[],
) {
  const skipped = parsedCount - rows.length
  if (skipped > 0) {
    console.log(`${label}: merged ${skipped} duplicate code rows`)
  }
}

function getConnectionString(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const host = process.env.CNIPA_PG_HOST
  const port = process.env.CNIPA_PG_PORT || '5432'
  const db = process.env.CNIPA_PG_DB
  const user = process.env.CNIPA_PG_USER
  const password = process.env.CNIPA_PG_PASSWORD
  if (host && db && user)
    return `postgresql://${user}:${password}@${host}:${port}/${db}`
  return ''
}

async function ensureClassificationTables(
  client: pg.PoolClient,
): Promise<void> {
  await client.query('CREATE SCHEMA IF NOT EXISTS cnipa')
  await client.query(`
    CREATE TABLE IF NOT EXISTS cnipa.ipc_classification (
      code_norm       TEXT PRIMARY KEY,
      code            TEXT NOT NULL,
      source_code     TEXT NOT NULL,
      version         TEXT NOT NULL,
      section         CHAR(1),
      class_code      TEXT,
      subclass        TEXT,
      main_group      TEXT,
      subgroup        TEXT,
      level           INTEGER,
      title_en        TEXT NOT NULL,
      title_zh        TEXT,
      title_zh_source TEXT,
      source_file     TEXT,
      created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT chk_ipc_title_zh_source
        CHECK (title_zh_source IS NULL OR title_zh_source IN ('cnipa', 'manual', 'machine'))
    )
  `)
  await client.query(`
    CREATE TABLE IF NOT EXISTS cnipa.cpc_classification (
      code_norm       TEXT PRIMARY KEY,
      code            TEXT NOT NULL,
      source_code     TEXT NOT NULL,
      version         TEXT NOT NULL,
      section         CHAR(1),
      class_code      TEXT,
      subclass        TEXT,
      main_group      TEXT,
      subgroup        TEXT,
      level           INTEGER,
      title_en        TEXT NOT NULL,
      title_zh        TEXT,
      title_zh_source TEXT,
      source_file     TEXT,
      created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT chk_cpc_title_zh_source
        CHECK (title_zh_source IS NULL OR title_zh_source IN ('official', 'manual', 'machine'))
    )
  `)
  await client.query(
    'CREATE INDEX IF NOT EXISTS idx_ipc_classification_section ON cnipa.ipc_classification(section)',
  )
  await client.query(
    'CREATE INDEX IF NOT EXISTS idx_ipc_classification_class_code ON cnipa.ipc_classification(class_code)',
  )
  await client.query(
    'CREATE INDEX IF NOT EXISTS idx_ipc_classification_subclass ON cnipa.ipc_classification(subclass)',
  )
  await client.query(
    'CREATE INDEX IF NOT EXISTS idx_cpc_classification_section ON cnipa.cpc_classification(section)',
  )
  await client.query(
    'CREATE INDEX IF NOT EXISTS idx_cpc_classification_class_code ON cnipa.cpc_classification(class_code)',
  )
  await client.query(
    'CREATE INDEX IF NOT EXISTS idx_cpc_classification_subclass ON cnipa.cpc_classification(subclass)',
  )
}

async function upsertRows(
  client: pg.PoolClient,
  tableName: 'ipc_classification' | 'cpc_classification',
  rows: ClassificationRow[],
): Promise<void> {
  const chunkSize = 500
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const chunk = rows.slice(offset, offset + chunkSize)
    const params = chunk.flatMap((row) => [
      row.code_norm,
      row.code,
      row.source_code,
      row.version,
      row.section,
      row.class_code,
      row.subclass,
      row.main_group,
      row.subgroup,
      row.level,
      row.title_en,
      row.title_zh,
      row.title_zh_source,
      row.source_file,
    ])
    const valueGroups = chunk.map((_, rowIndex) => {
      const base = rowIndex * INSERT_COLUMNS.length
      return `(${INSERT_COLUMNS.map((_, colIndex) => `$${base + colIndex + 1}`).join(', ')})`
    })

    await client.query(
      `INSERT INTO cnipa.${tableName} (${INSERT_COLUMNS.join(', ')})
       VALUES ${valueGroups.join(', ')}
       ON CONFLICT (code_norm) DO UPDATE SET
         code = EXCLUDED.code,
         source_code = EXCLUDED.source_code,
         version = EXCLUDED.version,
         section = EXCLUDED.section,
         class_code = EXCLUDED.class_code,
         subclass = EXCLUDED.subclass,
         main_group = EXCLUDED.main_group,
         subgroup = EXCLUDED.subgroup,
         level = EXCLUDED.level,
         title_en = EXCLUDED.title_en,
         title_zh = EXCLUDED.title_zh,
         title_zh_source = EXCLUDED.title_zh_source,
         source_file = EXCLUDED.source_file,
         updated_at = CURRENT_TIMESTAMP`,
      params,
    )
  }
}

function summarize(label: string, rows: ClassificationRow[]): void {
  const sample = rows
    .slice(0, 3)
    .map((row) => `${row.code_norm} ${row.title_en}`)
  console.log(`${label}: parsed ${rows.length} rows`)
  for (const line of sample) console.log(`  ${line}`)
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const parsedIpcRows = options.ipcSource
    ? parseIpcEntries(
        await loadTextEntries(options.ipcSource),
        options.ipcVersion,
      )
    : []
  const parsedCpcRows = options.cpcSource
    ? parseCpcEntries(
        await loadTextEntries(options.cpcSource),
        options.cpcVersion,
      )
    : []
  const ipcRows = dedupeRows(parsedIpcRows)
  const cpcRows = dedupeRows(parsedCpcRows)

  summarize('IPC', parsedIpcRows)
  logDedupe('IPC', parsedIpcRows.length, ipcRows)
  summarize('CPC', parsedCpcRows)
  logDedupe('CPC', parsedCpcRows.length, cpcRows)
  if (options.dryRun) return

  const connectionString = getConnectionString()
  if (!connectionString) {
    throw new Error(
      'Database is not configured. Set DATABASE_URL or CNIPA_PG_* variables.',
    )
  }

  const pool = new pg.Pool({ connectionString })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await ensureClassificationTables(client)
    if (ipcRows.length > 0)
      await upsertRows(client, 'ipc_classification', ipcRows)
    if (cpcRows.length > 0)
      await upsertRows(client, 'cpc_classification', cpcRows)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
