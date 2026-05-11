import { Pool, PoolClient } from 'pg'
import type {
  SyncBatch,
  Patent,
  SyncLog,
  ParsedPatent,
  DashboardStats,
  PatentFilter,
  PaginatedResponse,
  BatchStatus,
  LogLevel,
  PatentType,
} from '@/types'

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

// 创建连接池
const pool = new Pool({
  connectionString: getConnectionString() || undefined,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
})

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

// 初始化数据库表
export async function initializeDatabase(): Promise<void> {
  const client = await pool.connect()
  try {
    // 检测旧 schema（patents 表有 batch_id 而非 batch_code），需要重建
    const colCheck = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'patents' AND column_name = 'batch_code' LIMIT 1
    `)
    const patentsExists = await client.query(
      `SELECT EXISTS (SELECT FROM pg_tables WHERE tablename = 'patents')`,
    )
    if (patentsExists.rows[0].exists && colCheck.rows.length === 0) {
      await client.query(
        'DROP TABLE IF EXISTS sync_logs, patents, sync_batches CASCADE',
      )
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS sync_batches (
        batch_code      VARCHAR(50) PRIMARY KEY,
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
      CREATE TABLE IF NOT EXISTS patents (
        id                  SERIAL PRIMARY KEY,
        batch_code          VARCHAR(50) REFERENCES sync_batches(batch_code) ON DELETE CASCADE,
        patent_number       VARCHAR(50) UNIQUE NOT NULL,
        patent_type         VARCHAR(20) NOT NULL,
        title               TEXT NOT NULL,
        abstract            TEXT,
        claims              TEXT,
        applicant           TEXT,
        inventor            TEXT,
        application_number  VARCHAR(50),
        application_date    DATE,
        publication_number  VARCHAR(50),
        publication_date    DATE,
        grant_number        VARCHAR(50),
        grant_date          DATE,
        ipc_codes           TEXT[],
        agency              TEXT,
        agent               TEXT,
        priority_info       JSONB,
        raw_xml             TEXT,
        created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await client.query(`
      CREATE TABLE IF NOT EXISTS sync_logs (
        id          SERIAL PRIMARY KEY,
        batch_code  VARCHAR(50) REFERENCES sync_batches(batch_code) ON DELETE CASCADE,
        level       VARCHAR(10),
        message     TEXT,
        details     JSONB,
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_patents_type ON patents(patent_type)',
    )
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_patents_grant_date ON patents(grant_date)',
    )
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_patents_batch_code ON patents(batch_code)',
    )
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_sync_logs_batch_code ON sync_logs(batch_code)',
    )
  } finally {
    client.release()
  }
}

// ============ Batch 操作 ============

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

export async function getAllBatches(
  page = 1,
  limit = 20,
  status?: BatchStatus,
): Promise<PaginatedResponse<SyncBatch>> {
  const offset = (page - 1) * limit

  let whereClause = ''
  const params: (string | number)[] = []

  if (status) {
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
    status === 'extracting' ||
    status === 'parsing' ||
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

export async function deleteBatch(batchCode: string): Promise<void> {
  await pool.query('DELETE FROM sync_batches WHERE batch_code = $1', [
    batchCode,
  ])
}

// ============ Patent 操作 ============

export async function insertPatents(
  batchCode: string,
  patents: ParsedPatent[],
): Promise<number> {
  if (patents.length === 0) return 0

  const client = await pool.connect()
  let inserted = 0

  try {
    await client.query('BEGIN')

    for (const patent of patents) {
      try {
        await client.query(
          `INSERT INTO patents (
            batch_code, patent_number, patent_type, title, abstract, claims,
            applicant, inventor, application_number, application_date,
            publication_number, publication_date, grant_number, grant_date,
            ipc_codes, agency, agent, priority_info, raw_xml
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
          ON CONFLICT (patent_number) DO UPDATE SET
            title = EXCLUDED.title,
            abstract = EXCLUDED.abstract,
            claims = EXCLUDED.claims,
            updated_at = CURRENT_TIMESTAMP`,
          [
            batchCode,
            patent.patent_number,
            patent.patent_type,
            patent.title,
            patent.abstract || null,
            patent.claims || null,
            patent.applicant || null,
            patent.inventor || null,
            patent.application_number || null,
            patent.application_date || null,
            patent.publication_number || null,
            patent.publication_date || null,
            patent.grant_number || null,
            patent.grant_date || null,
            patent.ipc_codes || null,
            patent.agency || null,
            patent.agent || null,
            patent.priority_info ? JSON.stringify(patent.priority_info) : null,
            patent.raw_xml || null,
          ],
        )
        inserted++
      } catch (err) {
        console.error(`Failed to insert patent ${patent.patent_number}:`, err)
      }
    }

    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }

  return inserted
}

export async function getPatents(
  filter: PatentFilter,
  page = 1,
  limit = 50,
): Promise<PaginatedResponse<Patent>> {
  const offset = (page - 1) * limit
  const conditions: string[] = []
  const params: (string | number)[] = []

  if (filter.patent_type) {
    params.push(filter.patent_type)
    conditions.push(`patent_type = $${params.length}`)
  }

  if (filter.batch_code) {
    params.push(filter.batch_code)
    conditions.push(`batch_code = $${params.length}`)
  }

  if (filter.search) {
    params.push(`%${filter.search}%`)
    conditions.push(
      `(title ILIKE $${params.length} OR patent_number ILIKE $${params.length} OR applicant ILIKE $${params.length})`,
    )
  }

  if (filter.grant_date_from) {
    params.push(filter.grant_date_from)
    conditions.push(`grant_date >= $${params.length}`)
  }

  if (filter.grant_date_to) {
    params.push(filter.grant_date_to)
    conditions.push(`grant_date <= $${params.length}`)
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM patents ${whereClause}`,
    params,
  )
  const total = parseInt(countResult.rows[0].count)

  params.push(limit, offset)
  const result = await pool.query<Patent>(
    `SELECT * FROM patents ${whereClause} 
     ORDER BY grant_date DESC NULLS LAST, created_at DESC 
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  )

  return {
    items: result.rows,
    total,
    page,
    limit,
    total_pages: Math.ceil(total / limit),
  }
}

export async function getPatentById(id: number): Promise<Patent | null> {
  const result = await pool.query<Patent>(
    'SELECT * FROM patents WHERE id = $1',
    [id],
  )
  return result.rows[0] || null
}

// ============ Log 操作 ============

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
    ] = await Promise.all([
      client.query('SELECT COUNT(*) FROM sync_batches'),
      client.query(`
        SELECT 
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE patent_type = 'invention') as invention,
          COUNT(*) FILTER (WHERE patent_type = 'utility_model') as utility_model
        FROM patents
      `),
      client.query(`
        SELECT COUNT(*) FROM patents 
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
    }
  } finally {
    client.release()
  }
}

// 获取连接池用于事务操作
export function getPool(): Pool {
  return pool
}

export async function getClient(): Promise<PoolClient> {
  return pool.connect()
}
