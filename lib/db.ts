import { Pool, PoolClient } from 'pg'
import type {
  SyncBatch,
  SyncLog,
  Patent,
  PatentListItem,
  ParsedPatent,
  DashboardStats,
  PatentFilter,
  PaginatedResponse,
  BatchStatus,
  LogLevel,
  PatentType,
  PatentApplicantRow,
  PatentAgentRow,
  PatentCitationRow,
  PatentClaimRow,
  PatentImage,
  PatentImportFailure,
  PatentImportResult,
} from '@/types'
import { buildPatentSearchExpressionCondition } from './patent-search-expression'

function getConnectionString(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const host = process.env.CNIPA_PG_HOST
  const port = process.env.CNIPA_PG_PORT || '5432'
  const db = process.env.CNIPA_PG_DB
  const user = process.env.CNIPA_PG_USER
  const password = process.env.CNIPA_PG_PASSWORD
  if (host && db && user) {
    return `postgresql://${user}:${password}@${host}:${port}/${db}`
  }
  return ''
}

export function isDbConfigured(): boolean {
  return !!(
    process.env.DATABASE_URL ||
    (process.env.CNIPA_PG_HOST && process.env.CNIPA_PG_USER)
  )
}

const pool = new Pool({
  connectionString: getConnectionString() || undefined,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
})

type DependentView = {
  schema_name: string
  view_name: string
  definition: string
}

// 测试数据库连接
export async function testConnection(): Promise<{
  success: boolean
  error?: string
}> {
  try {
    const client = await pool.connect()
    await client.query('SELECT 1')
    client.release()
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

function getQualifiedName(schema: string, name: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`
}

async function getDependentViewsForColumns(
  client: PoolClient,
  schema: string,
  table: string,
  columns: string[],
): Promise<DependentView[]> {
  const { rows } = await client.query<DependentView>(
    `SELECT DISTINCT view_ns.nspname AS schema_name,
            view_cls.relname AS view_name,
            pg_get_viewdef(view_cls.oid, true) AS definition
       FROM pg_depend dep
       JOIN pg_rewrite rewrite ON rewrite.oid = dep.objid
       JOIN pg_class view_cls ON view_cls.oid = rewrite.ev_class
       JOIN pg_namespace view_ns ON view_ns.oid = view_cls.relnamespace
       JOIN pg_class table_cls ON table_cls.oid = dep.refobjid
       JOIN pg_namespace table_ns ON table_ns.oid = table_cls.relnamespace
       JOIN pg_attribute attr
         ON attr.attrelid = table_cls.oid AND attr.attnum = dep.refobjsubid
      WHERE table_ns.nspname = $1
        AND table_cls.relname = $2
        AND attr.attname = ANY($3)
        AND view_cls.relkind = 'v'
      ORDER BY view_ns.nspname, view_cls.relname`,
    [schema, table, columns],
  )
  return rows
}

// 仅在列存在且类型不是 text 时才 ALTER，避免每次请求重复 DDL
async function alterColumnsToTextIfNeeded(
  client: PoolClient,
  tableFqcn: string,
  columns: string[],
): Promise<void> {
  const [schema, table] = tableFqcn.split('.')
  const { rows } = await client.query(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2 AND column_name = ANY($3)`,
    [schema, table, columns],
  )
  const needsAlter = rows
    .filter(
      (r: { column_name: string; data_type: string }) => r.data_type !== 'text',
    )
    .map((r: { column_name: string }) => r.column_name)
  if (needsAlter.length === 0) return
  const alters = needsAlter.map(
    (c) => `ALTER COLUMN ${c} TYPE TEXT USING ${c}::TEXT`,
  )
  const dependentViews = await getDependentViewsForColumns(
    client,
    schema,
    table,
    needsAlter,
  )

  const droppedViews: DependentView[] = []
  try {
    for (const view of dependentViews) {
      await client.query(
        `DROP VIEW ${getQualifiedName(view.schema_name, view.view_name)}`,
      )
      droppedViews.push(view)
    }

    await client.query(`ALTER TABLE ${tableFqcn} ${alters.join(', ')}`)
  } finally {
    for (const view of droppedViews) {
      await client.query(
        `CREATE VIEW ${getQualifiedName(view.schema_name, view.view_name)} AS ${view.definition}`,
      )
    }
  }
}

async function relaxPatentKindConstraintIfNeeded(
  client: PoolClient,
): Promise<void> {
  const { rows } = await client.query<{ definition: string }>(
    `SELECT pg_get_constraintdef(oid, true) AS definition
       FROM pg_constraint
      WHERE conrelid = to_regclass('cnipa.patent')
        AND conname = 'chk_patent_kind'
        AND contype = 'c'`,
  )
  if (rows.length === 0) return

  const definition = rows[0]?.definition ?? ''
  if (definition.includes('kind ~')) return

  await client.query('ALTER TABLE cnipa.patent DROP CONSTRAINT chk_patent_kind')
  await client.query(
    `ALTER TABLE cnipa.patent
       ADD CONSTRAINT chk_patent_kind
       CHECK (kind ~ '^[A-Za-z0-9]{1,4}$')`,
  )
}

// 初始化数据库表（public: sync_batches + sync_logs; cnipa: patent + 子表）
export async function initializeDatabase(): Promise<void> {
  const client = await pool.connect()
  try {
    // === public schema: sync_batches ===
    await client.query(`
      CREATE TABLE IF NOT EXISTS sync_batches (
        batch_code      VARCHAR(100) PRIMARY KEY,
        data_type       VARCHAR(20) NOT NULL,
        ftp_folder      VARCHAR(500),
        status          VARCHAR(20) DEFAULT 'pending',
        total_files     INTEGER DEFAULT 0,
        processed_files INTEGER DEFAULT 0,
        total_patents   INTEGER DEFAULT 0,
        imported_patents INTEGER DEFAULT 0,
        error_message   TEXT,
        started_at      TIMESTAMP,
        completed_at    TIMESTAMP,
        created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await client.query(`
      CREATE TABLE IF NOT EXISTS sync_logs (
        id          SERIAL PRIMARY KEY,
        batch_code  VARCHAR(100) REFERENCES sync_batches(batch_code) ON DELETE CASCADE,
        level       VARCHAR(10),
        message     TEXT,
        details     JSONB,
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_sync_logs_batch_code ON sync_logs(batch_code)',
    )

    // === cnipa schema: patent 主表 + 子表 ===
    // 主表已由外部系统创建，这里兼容旧库的 CHAR(1) kind 列。
    // CNIPA 授权公告可能出现 B8、B9 等多字符 kind，不能截断为 B。
    await alterColumnsToTextIfNeeded(client, 'cnipa.patent', ['kind'])
    await relaxPatentKindConstraintIfNeeded(client)

    // 主表已由外部系统创建，这里仅确保子表存在
    await client.query(`
      CREATE TABLE IF NOT EXISTS cnipa.patent_applicant (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        patent_id   UUID NOT NULL REFERENCES cnipa.patent(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        address     TEXT,
        province    TEXT,
        city        TEXT,
        county      TEXT,
        postcode    TEXT
      )
    `)
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_pa_patent_id ON cnipa.patent_applicant(patent_id)',
    )
    await alterColumnsToTextIfNeeded(client, 'cnipa.patent_applicant', [
      'name',
      'address',
      'province',
      'city',
      'county',
      'postcode',
    ])

    await client.query(`
      CREATE TABLE IF NOT EXISTS cnipa.patent_inventor (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        patent_id   UUID NOT NULL REFERENCES cnipa.patent(id) ON DELETE CASCADE,
        name        TEXT NOT NULL
      )
    `)
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_pi_patent_id ON cnipa.patent_inventor(patent_id)',
    )

    await client.query(`
      CREATE TABLE IF NOT EXISTS cnipa.patent_agent (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        patent_id   UUID NOT NULL REFERENCES cnipa.patent(id) ON DELETE CASCADE,
        agency      TEXT,
        agent       TEXT
      )
    `)
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_pag_patent_id ON cnipa.patent_agent(patent_id)',
    )

    await client.query(`
      CREATE TABLE IF NOT EXISTS cnipa.patent_ipc (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        patent_id   UUID NOT NULL REFERENCES cnipa.patent(id) ON DELETE CASCADE,
        ipc_code    TEXT NOT NULL
      )
    `)
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_pic_patent_id ON cnipa.patent_ipc(patent_id)',
    )

    await client.query(`
      CREATE TABLE IF NOT EXISTS cnipa.patent_citation (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        patent_id   UUID NOT NULL REFERENCES cnipa.patent(id) ON DELETE CASCADE,
        country     TEXT,
        doc_number  TEXT,
        kind        TEXT,
        pub_date    DATE
      )
    `)
    // 发明授权引用文献可能包含 A1、B2 等多字符 kind；兼容旧库的 CHAR(1) 列。
    await alterColumnsToTextIfNeeded(client, 'cnipa.patent_citation', ['kind'])
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_pc_patent_id ON cnipa.patent_citation(patent_id)',
    )

    await client.query(`
      CREATE TABLE IF NOT EXISTS cnipa.patent_examiner (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        patent_id   UUID NOT NULL REFERENCES cnipa.patent(id) ON DELETE CASCADE,
        name        TEXT NOT NULL
      )
    `)
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_pe_patent_id ON cnipa.patent_examiner(patent_id)',
    )

    await client.query(`
      CREATE TABLE IF NOT EXISTS cnipa.patent_assignee (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        patent_id   UUID NOT NULL REFERENCES cnipa.patent(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        address     TEXT,
        province    TEXT,
        city        TEXT,
        postcode    TEXT
      )
    `)
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_pas_patent_id ON cnipa.patent_assignee(patent_id)',
    )
    await alterColumnsToTextIfNeeded(client, 'cnipa.patent_assignee', [
      'name',
      'address',
      'province',
      'city',
      'postcode',
    ])

    await client.query(`
      CREATE TABLE IF NOT EXISTS cnipa.patent_claim (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        patent_id   UUID NOT NULL REFERENCES cnipa.patent(id) ON DELETE CASCADE,
        claim_num   INTEGER NOT NULL,
        claim_text  TEXT NOT NULL
      )
    `)
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_pcl_patent_id ON cnipa.patent_claim(patent_id)',
    )

    await client.query(`
      CREATE TABLE IF NOT EXISTS cnipa.patent_image (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        patent_id    UUID NOT NULL REFERENCES cnipa.patent(id) ON DELETE CASCADE,
        file_name    TEXT NOT NULL,
        oss_key      TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size         INTEGER NOT NULL,
        width        INTEGER,
        height       INTEGER,
        is_abstract  BOOLEAN NOT NULL DEFAULT FALSE,
        created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_pimg_patent_id ON cnipa.patent_image(patent_id)',
    )
    await client.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_pimg_oss_key ON cnipa.patent_image(oss_key)',
    )
  } finally {
    client.release()
  }
}

// ============ Batch 操作（public schema，不变） ============

export async function createBatch(
  batchCode: string,
  dataType: PatentType,
  ftpFolder?: string,
): Promise<SyncBatch> {
  const result = await pool.query<SyncBatch>(
    `INSERT INTO sync_batches (batch_code, data_type, ftp_folder)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [batchCode, dataType, ftpFolder || null],
  )
  return result.rows[0]
}

export async function getBatchByCode(code: string): Promise<SyncBatch | null> {
  const result = await pool.query<SyncBatch>(
    'SELECT * FROM sync_batches WHERE batch_code = $1',
    [code],
  )
  return result.rows[0] || null
}

export async function getBatchByFtpFolder(
  ftpFolder: string,
): Promise<SyncBatch | null> {
  const result = await pool.query<SyncBatch>(
    'SELECT * FROM sync_batches WHERE ftp_folder = $1 ORDER BY created_at DESC LIMIT 1',
    [ftpFolder],
  )
  return result.rows[0] || null
}

export async function getAllBatches(
  page = 1,
  limit = 20,
  status?: BatchStatus,
  activeOnly = false,
): Promise<PaginatedResponse<SyncBatch>> {
  const offset = (page - 1) * limit
  let whereClause = ''
  const params: (string | number)[] = []

  if (activeOnly) {
    whereClause = "WHERE status IN ('downloading', 'processing', 'importing')"
  } else if (status) {
    whereClause = 'WHERE status = $1'
    params.push(status)
  }

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM sync_batches ${whereClause}`,
    params,
  )
  const total = parseInt(countResult.rows[0].count)

  const dataParams = status ? [status, limit, offset] : [limit, offset]
  const result = await pool.query<SyncBatch>(
    `SELECT * FROM sync_batches ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${status ? 2 : 1} OFFSET $${status ? 3 : 2}`,
    dataParams,
  )

  return {
    items: result.rows,
    total,
    page,
    limit,
    total_pages: Math.ceil(total / limit),
  }
}

export async function updateBatchStatus(
  batchCode: string,
  status: BatchStatus,
  errorMessage?: string,
): Promise<void> {
  const updates: string[] = ['status = $2']
  const params: (string | null)[] = [batchCode, status]

  if (
    status === 'downloading' ||
    status === 'processing' ||
    status === 'importing'
  ) {
    if (!(await getBatchStartedAt(batchCode))) {
      updates.push('started_at = CURRENT_TIMESTAMP')
    }
  }

  if (status === 'completed' || status === 'failed') {
    updates.push('completed_at = CURRENT_TIMESTAMP')
  }

  if (errorMessage !== undefined) {
    params.push(errorMessage)
    updates.push(`error_message = $${params.length}`)
  }

  await pool.query(
    `UPDATE sync_batches SET ${updates.join(', ')} WHERE batch_code = $1`,
    params,
  )
}

async function getBatchStartedAt(batchCode: string): Promise<Date | null> {
  const result = await pool.query(
    'SELECT started_at FROM sync_batches WHERE batch_code = $1',
    [batchCode],
  )
  return result.rows[0]?.started_at || null
}

export async function updateBatchProgress(
  batchCode: string,
  totalFiles?: number,
  processedFiles?: number,
  totalPatents?: number,
  importedPatents?: number,
): Promise<void> {
  const updates: string[] = []
  const params: (string | number)[] = [batchCode]

  if (totalFiles !== undefined) {
    params.push(totalFiles)
    updates.push(`total_files = $${params.length}`)
  }
  if (processedFiles !== undefined) {
    params.push(processedFiles)
    updates.push(`processed_files = $${params.length}`)
  }
  if (totalPatents !== undefined) {
    params.push(totalPatents)
    updates.push(`total_patents = $${params.length}`)
  }
  if (importedPatents !== undefined) {
    params.push(importedPatents)
    updates.push(`imported_patents = $${params.length}`)
  }

  if (updates.length > 0) {
    await pool.query(
      `UPDATE sync_batches SET ${updates.join(', ')} WHERE batch_code = $1`,
      params,
    )
  }
}

export async function countImportedPatentsByBatch(
  batchCode: string,
): Promise<number> {
  const result = await pool.query(
    'SELECT COUNT(*) FROM cnipa.patent WHERE batch_id = $1',
    [batchCode],
  )
  return parseInt(result.rows[0].count)
}

export async function getImportedPatentKeysByBatch(
  batchCode: string,
): Promise<Set<string>> {
  const result = await pool.query<{ doc_number: string; kind: string }>(
    'SELECT doc_number, kind FROM cnipa.patent WHERE batch_id = $1',
    [batchCode],
  )
  return new Set(result.rows.map((row) => `${row.doc_number}\u0000${row.kind}`))
}

async function deletePatentsByBatch(
  client: PoolClient,
  batchCode: string,
): Promise<number> {
  const result = await client.query<{ count: string }>(
    `WITH deleted AS (
       DELETE FROM cnipa.patent
       WHERE batch_id = $1
       RETURNING id
     )
     SELECT COUNT(*) AS count FROM deleted`,
    [batchCode],
  )
  return parseInt(result.rows[0]?.count || '0')
}

export async function deleteBatch(batchCode: string): Promise<{
  deletedPatents: number
}> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const deletedPatents = await deletePatentsByBatch(client, batchCode)
    await client.query('DELETE FROM sync_batches WHERE batch_code = $1', [
      batchCode,
    ])
    await client.query('COMMIT')
    return { deletedPatents }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

// ============ Patent 操作（cnipa schema） ============

function buildMultiRowInsert(
  table: string,
  columns: string[],
  rows: unknown[][],
): { sql: string; params: unknown[] } | null {
  if (rows.length === 0) return null
  const colCount = columns.length
  const MAX_PARAMS = 30000
  if (rows.length * colCount > MAX_PARAMS) {
    const chunkSize = Math.floor(MAX_PARAMS / colCount)
    const chunk = rows.slice(0, chunkSize)
    return buildMultiRowInsert(table, columns, chunk)
  }
  const placeholders = rows.map((_, ri) => {
    const base = ri * colCount
    return '(' + columns.map((_, ci) => `$${base + ci + 1}`).join(',') + ')'
  })
  return {
    sql: `INSERT INTO ${table} (${columns.join(',')}) VALUES ${placeholders.join(',')}`,
    params: rows.flat(),
  }
}

async function multiRowInsert(
  client: PoolClient,
  table: string,
  columns: string[],
  rows: unknown[][],
): Promise<void> {
  const colCount = columns.length
  const MAX_PARAMS = 30000
  const chunkSize = Math.max(1, Math.floor(MAX_PARAMS / colCount))
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const chunk = rows.slice(offset, offset + chunkSize)
    const q = buildMultiRowInsert(table, columns, chunk)
    if (q) await client.query(q.sql, q.params)
  }
}

function uniqueRows(rows: unknown[][]): unknown[][] {
  const seen = new Set<string>()
  return rows.filter((row) => {
    const key = JSON.stringify(row)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function getPatentKind(p: ParsedPatent): string {
  return p.kind || (p.patent_type === 'invention' ? 'B' : 'U')
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

function getPatentImportFailure(
  patent: ParsedPatent,
  error: unknown,
): PatentImportFailure {
  return {
    patent_number: patent.patent_number,
    kind: getPatentKind(patent),
    title: patent.title,
    source_file: patent.source_file || null,
    error: getErrorMessage(error),
  }
}

function getPatentDescriptionJson(p: ParsedPatent): string | null {
  const descJson: Record<string, string> = {}
  if (p.description_structured) {
    const d = p.description_structured
    if (d.technical_field) descJson.technical_field = d.technical_field
    if (d.background_art) descJson.background_art = d.background_art
    if (d.disclosure) descJson.disclosure = d.disclosure
    if (d.drawings_description)
      descJson.drawings_description = d.drawings_description
    if (d.embodiment) descJson.embodiment = d.embodiment
  }
  return Object.keys(descJson).length > 0 ? JSON.stringify(descJson) : null
}

// 将 ParsedPatent 写入 cnipa.patent + 子表
export async function insertPatents(
  batchCode: string,
  patents: ParsedPatent[],
): Promise<PatentImportResult> {
  if (patents.length === 0) return { insertedCount: 0, failures: [] }

  const client = await pool.connect()

  try {
    await client.query('BEGIN')
    const mainColumns = [
      'doc_number',
      'kind',
      'pub_country',
      'pub_date',
      'app_number',
      'app_date',
      'app_country',
      'app_type',
      'title',
      'abstract',
      'description',
      'claims',
      'status',
      'abstract_fig_key',
      'batch_id',
      'source_file',
      'grant_number',
      'grant_date',
      'priority_info',
      'raw_xml',
    ]
    const mainRows = patents.map((p) => [
      p.patent_number,
      getPatentKind(p),
      p.pub_country || null,
      p.publication_date || null,
      p.application_number || null,
      p.application_date || null,
      p.app_country || null,
      p.app_type || null,
      p.title,
      p.abstract || null,
      getPatentDescriptionJson(p),
      p.claims ? JSON.stringify(p.claims) : null,
      p.doc_status || null,
      p.abstract_figure || null,
      batchCode,
      p.source_file || null,
      p.grant_number || null,
      p.grant_date || null,
      p.priority_info ? JSON.stringify(p.priority_info) : null,
      p.raw_xml || null,
    ])
    const mainInsert = buildMultiRowInsert(
      'cnipa.patent',
      mainColumns,
      mainRows,
    )

    if (!mainInsert) {
      await client.query('COMMIT')
      return { insertedCount: 0, failures: [] }
    }

    const mainResult = await client.query<{
      id: string
      doc_number: string
      kind: string
      is_new: boolean
    }>(
      `${mainInsert.sql}
       ON CONFLICT (doc_number, kind) DO UPDATE SET
         title = EXCLUDED.title,
         abstract = EXCLUDED.abstract,
         description = COALESCE(EXCLUDED.description, cnipa.patent.description),
         claims = EXCLUDED.claims,
         grant_number = EXCLUDED.grant_number,
         grant_date = EXCLUDED.grant_date,
         abstract_fig_key = EXCLUDED.abstract_fig_key,
         batch_id = EXCLUDED.batch_id,
         source_file = EXCLUDED.source_file,
         updated_at = CURRENT_TIMESTAMP
       RETURNING id, doc_number, kind, (xmax = 0) AS is_new`,
      mainInsert.params,
    )

    const patentsByKey = new Map<string, ParsedPatent>()
    for (const p of patents) {
      patentsByKey.set(`${p.patent_number}\u0000${getPatentKind(p)}`, p)
    }

    const patentIdsByKey = new Map<string, string>()
    const updatedPatentIds: string[] = []
    for (const row of mainResult.rows) {
      patentIdsByKey.set(`${row.doc_number}\u0000${row.kind}`, row.id)
      if (!row.is_new) updatedPatentIds.push(row.id)
    }

    if (updatedPatentIds.length > 0) {
      const childTables = [
        'cnipa.patent_applicant',
        'cnipa.patent_inventor',
        'cnipa.patent_agent',
        'cnipa.patent_ipc',
        'cnipa.patent_citation',
        'cnipa.patent_examiner',
        'cnipa.patent_assignee',
        'cnipa.patent_claim',
        'cnipa.patent_image',
      ]
      for (const table of childTables) {
        await client.query(
          `DELETE FROM ${table} WHERE patent_id = ANY($1::uuid[])`,
          [updatedPatentIds],
        )
      }
    }

    const applicantRows: unknown[][] = []
    const inventorRows: unknown[][] = []
    const agentRows: unknown[][] = []
    const ipcRows: unknown[][] = []
    const citationRows: unknown[][] = []
    const examinerRows: unknown[][] = []
    const assigneeRows: unknown[][] = []
    const claimRows: unknown[][] = []
    const imageRows: unknown[][] = []

    for (const [key, p] of patentsByKey) {
      const patentId = patentIdsByKey.get(key)
      if (!patentId) continue

      for (const a of p.applicants_structured || []) {
        applicantRows.push([
          patentId,
          a.name,
          a.address || null,
          a.province || null,
          a.city || null,
          a.county || null,
          a.postcode || null,
        ])
      }
      for (const name of p.inventors_structured || []) {
        inventorRows.push([patentId, name])
      }
      for (const a of p.agents_structured || []) {
        agentRows.push([patentId, a.agency_name || null, a.agent_name || null])
      }
      for (const code of p.ipc_codes || []) {
        ipcRows.push([patentId, code])
      }
      for (const c of p.citations || []) {
        citationRows.push([
          patentId,
          c.country || null,
          c.doc_number || null,
          c.kind || null,
          c.pub_date || null,
        ])
      }
      for (const name of p.examiners || []) {
        examinerRows.push([patentId, name])
      }
      for (const a of p.assignees || []) {
        assigneeRows.push([
          patentId,
          a.name,
          a.address || null,
          a.province || null,
          a.city || null,
          a.postcode || null,
        ])
      }
      for (let ci = 0; ci < (p.claims_structured || []).length; ci++) {
        const claim = p.claims_structured?.[ci]
        if (claim) claimRows.push([patentId, ci + 1, claim.texts.join('\n')])
      }
      for (const image of p.images || []) {
        imageRows.push([
          patentId,
          image.file_name,
          image.oss_key,
          image.content_type,
          image.size,
          image.width || null,
          image.height || null,
          image.is_abstract,
        ])
      }
    }

    await multiRowInsert(
      client,
      'cnipa.patent_applicant',
      [
        'patent_id',
        'name',
        'address',
        'province',
        'city',
        'county',
        'postcode',
      ],
      uniqueRows(applicantRows),
    )
    await multiRowInsert(
      client,
      'cnipa.patent_inventor',
      ['patent_id', 'name'],
      uniqueRows(inventorRows),
    )
    await multiRowInsert(
      client,
      'cnipa.patent_agent',
      ['patent_id', 'agency', 'agent'],
      uniqueRows(agentRows),
    )
    await multiRowInsert(
      client,
      'cnipa.patent_ipc',
      ['patent_id', 'ipc_code'],
      uniqueRows(ipcRows),
    )
    await multiRowInsert(
      client,
      'cnipa.patent_citation',
      ['patent_id', 'country', 'doc_number', 'kind', 'pub_date'],
      uniqueRows(citationRows),
    )
    await multiRowInsert(
      client,
      'cnipa.patent_examiner',
      ['patent_id', 'name'],
      uniqueRows(examinerRows),
    )
    await multiRowInsert(
      client,
      'cnipa.patent_assignee',
      ['patent_id', 'name', 'address', 'province', 'city', 'postcode'],
      uniqueRows(assigneeRows),
    )
    await multiRowInsert(
      client,
      'cnipa.patent_claim',
      ['patent_id', 'claim_num', 'claim_text'],
      uniqueRows(claimRows),
    )
    await multiRowInsert(
      client,
      'cnipa.patent_image',
      [
        'patent_id',
        'file_name',
        'oss_key',
        'content_type',
        'size',
        'width',
        'height',
        'is_abstract',
      ],
      uniqueRows(imageRows),
    )

    await client.query('COMMIT')
    return { insertedCount: mainResult.rowCount || 0, failures: [] }
  } catch (error) {
    await client.query('ROLLBACK')
    if (patents.length === 1) {
      return {
        insertedCount: 0,
        failures: [getPatentImportFailure(patents[0], error)],
      }
    }

    const mid = Math.floor(patents.length / 2)
    const left = await insertPatents(batchCode, patents.slice(0, mid))
    const right = await insertPatents(batchCode, patents.slice(mid))
    return {
      insertedCount: left.insertedCount + right.insertedCount,
      failures: [...left.failures, ...right.failures],
    }
  } finally {
    client.release()
  }
}

// 将数据库行转为 Patent 对象（主表 + 子表聚合）
function rowToPatent(row: Record<string, unknown>): Patent {
  return {
    id: row.id as string,
    doc_number: row.doc_number as string,
    kind: row.kind as string,
    pub_country: (row.pub_country as string) || null,
    pub_date: (row.pub_date as Date) || null,
    app_number: (row.app_number as string) || null,
    app_date: (row.app_date as Date) || null,
    app_country: (row.app_country as string) || null,
    app_type: (row.app_type as string) || null,
    title: row.title as string,
    abstract: (row.abstract as string) || null,
    description: row.description as Record<string, string> | null,
    claims: (row.claims_text as string) || (row.claims as string) || null,
    status: (row.status as string) || null,
    abstract_fig_key: (row.abstract_fig_key as string) || null,
    images: ((row.images as PatentImage[]) || []).sort((a, b) => {
      if (a.is_abstract !== b.is_abstract) return a.is_abstract ? -1 : 1
      return a.file_name.localeCompare(b.file_name)
    }),
    batch_id: (row.batch_id as string) || null,
    source_file: (row.source_file as string) || null,
    grant_number: (row.grant_number as string) || null,
    grant_date: (row.grant_date as Date) || null,
    priority_info: row.priority_info as Record<string, unknown> | null,
    created_at: row.created_at as Date,
    updated_at: row.updated_at as Date,
    // 子表聚合（由查询填充）
    applicants: (row.applicants as PatentApplicantRow[]) || [],
    inventors: (row.inventors as string[]) || [],
    agents: (row.agents as PatentAgentRow[]) || [],
    citations: (row.citations as PatentCitationRow[]) || [],
    examiners: (row.examiners as string[]) || [],
    assignees: (row.assignees as PatentApplicantRow[]) || [],
    ipc_codes: (row.ipc_codes as string[]) || [],
    claims_structured: (row.claims_structured as PatentClaimRow[]) || [],
  }
}

function rowToPatentListItem(row: Record<string, unknown>): PatentListItem {
  return {
    id: row.id as string,
    doc_number: row.doc_number as string,
    kind: row.kind as string,
    title: row.title as string,
    pub_date: (row.pub_date as Date) || null,
    applicants: (row.applicants as PatentApplicantRow[]) || [],
  }
}

export async function getPatentList(
  filter: PatentFilter,
  page = 1,
  limit = 50,
): Promise<PaginatedResponse<PatentListItem>> {
  const offset = (page - 1) * limit
  const conditions: string[] = []
  const params: (string | number)[] = []
  let paramIdx = 1

  if (filter.kind) {
    params.push(filter.kind)
    conditions.push(`p.kind = $${paramIdx++}`)
  }
  if (filter.app_type) {
    params.push(filter.app_type)
    conditions.push(`p.app_type = $${paramIdx++}`)
  }
  if (filter.batch_id) {
    params.push(filter.batch_id)
    conditions.push(`p.batch_id = $${paramIdx++}`)
  }
  if (filter.pub_date_from) {
    params.push(filter.pub_date_from)
    conditions.push(`p.pub_date >= $${paramIdx++}`)
  }
  if (filter.pub_date_to) {
    params.push(filter.pub_date_to)
    conditions.push(`p.pub_date <= $${paramIdx++}`)
  }
  if (filter.search) {
    params.push(`%${filter.search}%`)
    conditions.push(
      `(p.title ILIKE $${paramIdx} OR p.doc_number ILIKE $${paramIdx} OR EXISTS (SELECT 1 FROM cnipa.patent_applicant pa WHERE pa.patent_id = p.id AND pa.name ILIKE $${paramIdx}))`,
    )
    paramIdx++
  }
  const expressionCondition = buildPatentSearchExpressionCondition(
    filter.expression,
    paramIdx,
  )
  if (expressionCondition) {
    conditions.push(expressionCondition.sql)
    params.push(...expressionCondition.params)
    paramIdx = expressionCondition.nextParamIndex
  }
  if (filter.province) {
    params.push(filter.province)
    conditions.push(
      `EXISTS (SELECT 1 FROM cnipa.patent_applicant pa WHERE pa.patent_id = p.id AND pa.province = $${paramIdx++})`,
    )
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM cnipa.patent p ${whereClause}`,
    params,
  )
  const total = parseInt(countResult.rows[0].count)

  params.push(limit, offset)
  const result = await pool.query(
    `SELECT p.id, p.doc_number, p.kind, p.title, p.pub_date,
      COALESCE(
        json_agg(DISTINCT jsonb_build_object('name', pa.name, 'address', pa.address, 'province', pa.province, 'city', pa.city, 'county', pa.county, 'postcode', pa.postcode))
        FILTER (WHERE pa.id IS NOT NULL), '[]'
      ) AS applicants
    FROM cnipa.patent p
    LEFT JOIN cnipa.patent_applicant pa ON pa.patent_id = p.id
    ${whereClause}
    GROUP BY p.id
    ORDER BY p.pub_date DESC NULLS LAST, p.created_at DESC
    LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
    params,
  )

  return {
    items: result.rows.map(rowToPatentListItem),
    total,
    page,
    limit,
    total_pages: Math.ceil(total / limit),
  }
}

export async function getPatentById(id: string): Promise<Patent | null> {
  const result = await pool.query(
    `SELECT p.*,
      COALESCE(
        json_agg(DISTINCT jsonb_build_object('name', pa.name, 'address', pa.address, 'province', pa.province, 'city', pa.city, 'county', pa.county, 'postcode', pa.postcode))
        FILTER (WHERE pa.id IS NOT NULL), '[]'
      ) AS applicants,
      COALESCE(
        json_agg(DISTINCT pi.name) FILTER (WHERE pi.id IS NOT NULL), '[]'
      ) AS inventors,
      COALESCE(
        json_agg(DISTINCT jsonb_build_object('agency', pg.agency, 'agent', pg.agent))
        FILTER (WHERE pg.id IS NOT NULL), '[]'
      ) AS agents,
      COALESCE(
        json_agg(DISTINCT pic.ipc_code) FILTER (WHERE pic.id IS NOT NULL), '[]'
      ) AS ipc_codes,
      COALESCE(
        json_agg(DISTINCT jsonb_build_object('country', pc.country, 'doc_number', pc.doc_number, 'kind', pc.kind, 'pub_date', pc.pub_date))
        FILTER (WHERE pc.id IS NOT NULL), '[]'
      ) AS citations,
      COALESCE(
        json_agg(DISTINCT pe.name) FILTER (WHERE pe.id IS NOT NULL), '[]'
      ) AS examiners,
      COALESCE(
        json_agg(DISTINCT jsonb_build_object('name', pas.name, 'address', pas.address, 'province', pas.province, 'city', pas.city, 'postcode', pas.postcode))
        FILTER (WHERE pas.id IS NOT NULL), '[]'
      ) AS assignees,
      COALESCE(
        json_agg(DISTINCT jsonb_build_object('claim_num', pcl.claim_num, 'claim_text', pcl.claim_text))
        FILTER (WHERE pcl.id IS NOT NULL), '[]'
      ) AS claims_structured,
      COALESCE(
        json_agg(DISTINCT jsonb_build_object('id', pimg.id, 'patent_id', pimg.patent_id, 'file_name', pimg.file_name, 'oss_key', pimg.oss_key, 'content_type', pimg.content_type, 'size', pimg.size, 'width', pimg.width, 'height', pimg.height, 'is_abstract', pimg.is_abstract, 'created_at', pimg.created_at))
        FILTER (WHERE pimg.id IS NOT NULL), '[]'
      ) AS images
    FROM cnipa.patent p
    LEFT JOIN cnipa.patent_applicant pa ON pa.patent_id = p.id
    LEFT JOIN cnipa.patent_inventor pi ON pi.patent_id = p.id
    LEFT JOIN cnipa.patent_agent pg ON pg.patent_id = p.id
    LEFT JOIN cnipa.patent_ipc pic ON pic.patent_id = p.id
    LEFT JOIN cnipa.patent_citation pc ON pc.patent_id = p.id
    LEFT JOIN cnipa.patent_examiner pe ON pe.patent_id = p.id
    LEFT JOIN cnipa.patent_assignee pas ON pas.patent_id = p.id
    LEFT JOIN cnipa.patent_claim pcl ON pcl.patent_id = p.id
    LEFT JOIN cnipa.patent_image pimg ON pimg.patent_id = p.id
    WHERE p.id = $1
    GROUP BY p.id`,
    [id],
  )

  if (result.rows.length === 0) return null
  return rowToPatent(result.rows[0])
}

export async function getPatentImageById(
  id: string,
): Promise<PatentImage | null> {
  const result = await pool.query<PatentImage>(
    `SELECT id, patent_id, file_name, oss_key, content_type, size, width, height, is_abstract, created_at
       FROM cnipa.patent_image
      WHERE id = $1`,
    [id],
  )

  return result.rows[0] || null
}

// ============ Log 操作（public schema，不变） ============

export async function addLog(
  batchCode: string,
  level: LogLevel,
  message: string,
  details?: Record<string, unknown>,
): Promise<void> {
  await pool.query(
    'INSERT INTO sync_logs (batch_code, level, message, details) VALUES ($1, $2, $3, $4)',
    [batchCode, level, message, details ? JSON.stringify(details) : null],
  )
}

export async function getLogsByBatch(
  batchCode: string,
  limit = 100,
): Promise<SyncLog[]> {
  const result = await pool.query<SyncLog>(
    'SELECT * FROM sync_logs WHERE batch_code = $1 ORDER BY created_at DESC LIMIT $2',
    [batchCode, limit],
  )
  return result.rows
}

// ============ 统计 ============

export async function getDashboardStats(): Promise<DashboardStats> {
  const client = await pool.connect()
  try {
    const [
      batchCount,
      patentCounts,
      weekPatents,
      lastSync,
      pendingCount,
      failedCount,
      applicantCount,
      inventorCount,
      citationCount,
    ] = await Promise.all([
      client.query('SELECT COUNT(*) FROM sync_batches'),
      client.query(`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE kind = 'B') as invention,
          COUNT(*) FILTER (WHERE kind = 'U') as utility_model
        FROM cnipa.patent
      `),
      client.query(`
        SELECT COUNT(*) FROM cnipa.patent
        WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'
      `),
      client.query(`
        SELECT completed_at FROM sync_batches
        WHERE status = 'completed'
        ORDER BY completed_at DESC LIMIT 1
      `),
      client.query(
        "SELECT COUNT(*) FROM sync_batches WHERE status = 'pending'",
      ),
      client.query("SELECT COUNT(*) FROM sync_batches WHERE status = 'failed'"),
      client.query('SELECT COUNT(*) FROM cnipa.patent_applicant'),
      client.query('SELECT COUNT(*) FROM cnipa.patent_inventor'),
      client.query('SELECT COUNT(*) FROM cnipa.patent_citation'),
    ])

    return {
      total_batches: parseInt(batchCount.rows[0].count),
      total_patents: parseInt(patentCounts.rows[0].total),
      invention_patents: parseInt(patentCounts.rows[0].invention),
      utility_model_patents: parseInt(patentCounts.rows[0].utility_model),
      this_week_patents: parseInt(weekPatents.rows[0].count),
      last_sync_at: lastSync.rows[0]?.completed_at || null,
      pending_batches: parseInt(pendingCount.rows[0].count),
      failed_batches: parseInt(failedCount.rows[0].count),
      total_applicants: parseInt(applicantCount.rows[0].count),
      total_inventors: parseInt(inventorCount.rows[0].count),
      total_citations: parseInt(citationCount.rows[0].count),
    }
  } finally {
    client.release()
  }
}

export function getPool(): Pool {
  return pool
}

export async function getClient(): Promise<PoolClient> {
  return pool.connect()
}
