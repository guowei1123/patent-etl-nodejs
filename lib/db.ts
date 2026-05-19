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

export async function deleteBatch(batchCode: string): Promise<void> {
  await pool.query('DELETE FROM sync_batches WHERE batch_code = $1', [
    batchCode,
  ])
}

// ============ Patent 操作（cnipa schema） ============

// 将 ParsedPatent 写入 cnipa.patent + 子表
export async function insertPatents(
  batchCode: string,
  patents: ParsedPatent[],
): Promise<number> {
  if (patents.length === 0) return 0

  const client = await pool.connect()
  let inserted = 0

  try {
    await client.query('BEGIN')

    for (const p of patents) {
      const spName = `sp_${inserted}`
      try {
        await client.query(`SAVEPOINT ${spName}`)

        // 1. INSERT 主表
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

        const claimsValue = p.claims ? JSON.stringify(p.claims) : null

        const mainResult = await client.query(
          `INSERT INTO cnipa.patent (
            doc_number, kind, pub_country, pub_date,
            app_number, app_date, app_country, app_type,
            title, abstract, description, claims,
            status, abstract_fig_key,
            batch_id, source_file,
            grant_number, grant_date, priority_info, raw_xml
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
          ON CONFLICT (doc_number, kind) DO UPDATE SET
            title = EXCLUDED.title,
            abstract = EXCLUDED.abstract,
            description = COALESCE(EXCLUDED.description, cnipa.patent.description),
            claims = EXCLUDED.claims,
            grant_number = EXCLUDED.grant_number,
            grant_date = EXCLUDED.grant_date,
            updated_at = CURRENT_TIMESTAMP
          RETURNING id`,
          [
            p.patent_number,
            p.kind || (p.patent_type === 'invention' ? 'B' : 'U'),
            p.pub_country || null,
            p.publication_date || null,
            p.application_number || null,
            p.application_date || null,
            p.app_country || null,
            p.app_type || null,
            p.title,
            p.abstract || null,
            Object.keys(descJson).length > 0 ? JSON.stringify(descJson) : null,
            claimsValue,
            p.doc_status || null,
            p.abstract_figure || null,
            batchCode,
            p.source_file || null,
            p.grant_number || null,
            p.grant_date || null,
            p.priority_info ? JSON.stringify(p.priority_info) : null,
            p.raw_xml || null,
          ],
        )

        const patentId: string = mainResult.rows[0].id

        // 2. INSERT 子表 — 先删除旧数据（ON CONFLICT 时更新）
        await client.query(
          'DELETE FROM cnipa.patent_applicant WHERE patent_id = $1',
          [patentId],
        )
        await client.query(
          'DELETE FROM cnipa.patent_inventor WHERE patent_id = $1',
          [patentId],
        )
        await client.query(
          'DELETE FROM cnipa.patent_agent WHERE patent_id = $1',
          [patentId],
        )
        await client.query(
          'DELETE FROM cnipa.patent_ipc WHERE patent_id = $1',
          [patentId],
        )
        await client.query(
          'DELETE FROM cnipa.patent_citation WHERE patent_id = $1',
          [patentId],
        )
        await client.query(
          'DELETE FROM cnipa.patent_examiner WHERE patent_id = $1',
          [patentId],
        )
        await client.query(
          'DELETE FROM cnipa.patent_assignee WHERE patent_id = $1',
          [patentId],
        )
        await client.query(
          'DELETE FROM cnipa.patent_claim WHERE patent_id = $1',
          [patentId],
        )

        // 申请人
        if (p.applicants_structured) {
          for (const a of p.applicants_structured) {
            await client.query(
              `INSERT INTO cnipa.patent_applicant (patent_id, name, address, province, city, county, postcode)
               VALUES ($1,$2,$3,$4,$5,$6,$7)`,
              [
                patentId,
                a.name,
                a.address || null,
                a.province || null,
                a.city || null,
                a.county || null,
                a.postcode || null,
              ],
            )
          }
        }

        // 发明人
        if (p.inventors_structured) {
          for (const name of p.inventors_structured) {
            await client.query(
              'INSERT INTO cnipa.patent_inventor (patent_id, name) VALUES ($1,$2)',
              [patentId, name],
            )
          }
        }

        // 代理人/机构
        if (p.agents_structured) {
          for (const a of p.agents_structured) {
            await client.query(
              `INSERT INTO cnipa.patent_agent (patent_id, agency, agent)
               VALUES ($1,$2,$3)`,
              [patentId, a.agency_name || null, a.agent_name || null],
            )
          }
        }

        // IPC 分类
        if (p.ipc_codes) {
          for (const code of p.ipc_codes) {
            await client.query(
              'INSERT INTO cnipa.patent_ipc (patent_id, ipc_code) VALUES ($1,$2)',
              [patentId, code],
            )
          }
        }

        // 引用文献
        if (p.citations) {
          for (const c of p.citations) {
            await client.query(
              `INSERT INTO cnipa.patent_citation (patent_id, country, doc_number, kind, pub_date)
               VALUES ($1,$2,$3,$4,$5)`,
              [
                patentId,
                c.country || null,
                c.doc_number || null,
                c.kind || null,
                c.pub_date || null,
              ],
            )
          }
        }

        // 审查员
        if (p.examiners) {
          for (const name of p.examiners) {
            await client.query(
              'INSERT INTO cnipa.patent_examiner (patent_id, name) VALUES ($1,$2)',
              [patentId, name],
            )
          }
        }

        // 受让人
        if (p.assignees) {
          for (const a of p.assignees) {
            await client.query(
              `INSERT INTO cnipa.patent_assignee (patent_id, name, address, province, city, postcode)
               VALUES ($1,$2,$3,$4,$5,$6)`,
              [
                patentId,
                a.name,
                a.address || null,
                a.province || null,
                a.city || null,
                a.postcode || null,
              ],
            )
          }
        }

        // 结构化权利要求
        if (p.claims_structured) {
          for (let ci = 0; ci < p.claims_structured.length; ci++) {
            const claim = p.claims_structured[ci]
            const text = claim.texts.join('\n')
            await client.query(
              'INSERT INTO cnipa.patent_claim (patent_id, claim_num, claim_text) VALUES ($1,$2,$3)',
              [patentId, ci + 1, text],
            )
          }
        }

        await client.query(`RELEASE SAVEPOINT ${spName}`)
        inserted++
      } catch (err) {
        console.error(`Failed to insert patent ${p.patent_number}:`, err)
        await client.query(`ROLLBACK TO SAVEPOINT ${spName}`)
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
      ) AS claims_structured
    FROM cnipa.patent p
    LEFT JOIN cnipa.patent_applicant pa ON pa.patent_id = p.id
    LEFT JOIN cnipa.patent_inventor pi ON pi.patent_id = p.id
    LEFT JOIN cnipa.patent_agent pg ON pg.patent_id = p.id
    LEFT JOIN cnipa.patent_ipc pic ON pic.patent_id = p.id
    LEFT JOIN cnipa.patent_citation pc ON pc.patent_id = p.id
    LEFT JOIN cnipa.patent_examiner pe ON pe.patent_id = p.id
    LEFT JOIN cnipa.patent_assignee pas ON pas.patent_id = p.id
    LEFT JOIN cnipa.patent_claim pcl ON pcl.patent_id = p.id
    WHERE p.id = $1
    GROUP BY p.id`,
    [id],
  )

  if (result.rows.length === 0) return null
  return rowToPatent(result.rows[0])
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
