import Database from 'better-sqlite3'
import path from 'path'
import type * as net from 'net'
import type {
  BatchStatus,
  ClassificationFilter,
  ClassificationRow,
  ClassificationSemanticRow,
  ClassificationTreeNode,
  ClassificationTreeResponse,
  DashboardStats,
  LogLevel,
  PaginatedResponse,
  ParsedPatent,
  Patent,
  PatentFilter,
  PatentImage,
  PatentListItem,
  PatentType,
  SyncBatch,
  SyncLog,
  PatentImportResult,
} from '@/types'
import {
  getClassificationAncestorCodeNorms,
  getClassificationDepth,
  getClassificationParentCodeNorm,
  normalizeClassificationCodeNorm,
  splitClassificationCode,
} from './classification-code'

function getDbPath(): string {
  if (process.env.DATABASE_PATH) return path.resolve(process.env.DATABASE_PATH)
  return path.join(process.cwd(), 'data', 'patent-etl.sqlite')
}

const db = new Database(getDbPath(), { readonly: false })
db.pragma('foreign_keys = ON')

export function isDbConfigured(): boolean {
  return true
}

export async function testConnection(): Promise<{ success: boolean; error?: string }> {
  try {
    db.prepare('SELECT 1').get()
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

export async function initializeDatabase(): Promise<void> {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_batches (
      batch_code TEXT PRIMARY KEY,
      data_type TEXT NOT NULL,
      ftp_folder TEXT,
      status TEXT DEFAULT 'pending',
      total_files INTEGER DEFAULT 0,
      processed_files INTEGER DEFAULT 0,
      total_patents INTEGER DEFAULT 0,
      imported_patents INTEGER DEFAULT 0,
      error_message TEXT,
      started_at DATETIME,
      completed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS sync_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_code TEXT,
      level TEXT,
      message TEXT,
      details TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `)
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (!value || typeof value !== 'string') return fallback
  try { return JSON.parse(value) as T } catch { return fallback }
}

function toDate(value: unknown): Date | null {
  return value ? new Date(String(value)) : null
}

function rowToBatch(row: Record<string, unknown>): SyncBatch {
  return {
    batch_code: String(row.batch_code),
    data_type: row.data_type as PatentType,
    ftp_folder: row.ftp_folder ? String(row.ftp_folder) : null,
    status: row.status as BatchStatus,
    total_files: Number(row.total_files || 0),
    processed_files: Number(row.processed_files || 0),
    total_patents: Number(row.total_patents || 0),
    imported_patents: Number(row.imported_patents || 0),
    error_message: row.error_message ? String(row.error_message) : null,
    started_at: toDate(row.started_at),
    completed_at: toDate(row.completed_at),
    created_at: toDate(row.created_at) || new Date(),
  }
}

export async function createBatch(batchCode: string, dataType: PatentType, ftpFolder?: string): Promise<SyncBatch> {
  db.prepare('INSERT INTO sync_batches (batch_code, data_type, ftp_folder) VALUES (?, ?, ?)').run(batchCode, dataType, ftpFolder || null)
  return (await getBatchByCode(batchCode))!
}

export async function getBatchByCode(code: string): Promise<SyncBatch | null> {
  const row = db.prepare('SELECT * FROM sync_batches WHERE batch_code = ?').get(code) as Record<string, unknown> | undefined
  return row ? rowToBatch(row) : null
}

export async function getBatchByFtpFolder(ftpFolder: string): Promise<SyncBatch | null> {
  const row = db.prepare('SELECT * FROM sync_batches WHERE ftp_folder = ? ORDER BY created_at DESC LIMIT 1').get(ftpFolder) as Record<string, unknown> | undefined
  return row ? rowToBatch(row) : null
}

export async function getAllBatches(page = 1, limit = 20, status?: BatchStatus, activeOnly = false): Promise<PaginatedResponse<SyncBatch>> {
  const where = activeOnly ? "WHERE status IN ('downloading','processing','importing')" : status ? 'WHERE status = ?' : ''
  const countParams = status && !activeOnly ? [status] : []
  const total = Number((db.prepare(`SELECT COUNT(*) AS count FROM sync_batches ${where}`).get(...countParams) as { count: number }).count)
  const rows = db.prepare(`SELECT * FROM sync_batches ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...countParams, limit, (page - 1) * limit) as Record<string, unknown>[]
  return { items: rows.map(rowToBatch), total, page, limit, total_pages: Math.ceil(total / limit) }
}

export async function updateBatchStatus(batchCode: string, status: BatchStatus, errorMessage?: string): Promise<void> {
  db.prepare('UPDATE sync_batches SET status = ?, error_message = COALESCE(?, error_message) WHERE batch_code = ?').run(status, errorMessage ?? null, batchCode)
}

export async function updateBatchProgress(batchCode: string, totalFiles?: number, processedFiles?: number, totalPatents?: number, importedPatents?: number): Promise<void> {
  db.prepare(`UPDATE sync_batches SET
    total_files = COALESCE(?, total_files), processed_files = COALESCE(?, processed_files),
    total_patents = COALESCE(?, total_patents), imported_patents = COALESCE(?, imported_patents)
    WHERE batch_code = ?`).run(totalFiles ?? null, processedFiles ?? null, totalPatents ?? null, importedPatents ?? null, batchCode)
}

export async function countImportedPatentsByBatch(batchCode: string): Promise<number> {
  return Number((db.prepare('SELECT COUNT(*) AS count FROM cnipa_patent WHERE batch_id = ?').get(batchCode) as { count: number }).count)
}

export async function getImportedPatentKeysByBatch(batchCode: string): Promise<Set<string>> {
  const rows = db.prepare('SELECT doc_number, kind FROM cnipa_patent WHERE batch_id = ?').all(batchCode) as { doc_number: string; kind: string }[]
  return new Set(rows.map((row) => `${row.doc_number}\u0000${row.kind}`))
}

export async function deleteBatch(batchCode: string): Promise<{ deleted: boolean }> {
  const result = db.prepare('DELETE FROM sync_batches WHERE batch_code = ?').run(batchCode)
  return { deleted: result.changes > 0 }
}

export async function insertPatents(_batchCode: string, _patents: ParsedPatent[]): Promise<PatentImportResult> {
  throw new Error('SQLite local mode is read-only for patent import')
}

function makeLike(value: string): string { return `%${value}%` }

function rowToPatentListItem(row: Record<string, unknown>): PatentListItem {
  const applicants = db.prepare('SELECT name, address, province, city, county, postcode FROM cnipa_patent_applicant WHERE patent_id = ?').all(row.id) as PatentListItem['applicants']
  return { id: String(row.id), doc_number: String(row.doc_number), kind: String(row.kind), title: String(row.title), pub_date: toDate(row.pub_date), applicants }
}

export async function getPatentList(filter: PatentFilter, page = 1, limit = 50): Promise<PaginatedResponse<PatentListItem>> {
  const conditions: string[] = []
  const params: unknown[] = []
  if (filter.kind) { conditions.push('p.kind = ?'); params.push(filter.kind) }
  if (filter.app_type) { conditions.push('p.app_type = ?'); params.push(filter.app_type) }
  if (filter.batch_id) { conditions.push('p.batch_id = ?'); params.push(filter.batch_id) }
  if (filter.pub_date_from) { conditions.push('p.pub_date >= ?'); params.push(filter.pub_date_from) }
  if (filter.pub_date_to) { conditions.push('p.pub_date <= ?'); params.push(filter.pub_date_to) }
  if (filter.search) {
    conditions.push('(p.title LIKE ? OR p.doc_number LIKE ? OR EXISTS (SELECT 1 FROM cnipa_patent_applicant pa WHERE pa.patent_id = p.id AND pa.name LIKE ?))')
    params.push(makeLike(filter.search), makeLike(filter.search), makeLike(filter.search))
  }
  if (filter.province) {
    conditions.push('EXISTS (SELECT 1 FROM cnipa_patent_applicant pa WHERE pa.patent_id = p.id AND pa.province = ?)')
    params.push(filter.province)
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const total = Number((db.prepare(`SELECT COUNT(*) AS count FROM cnipa_patent p ${where}`).get(...params) as { count: number }).count)
  const rows = db.prepare(`SELECT p.id, p.doc_number, p.kind, p.title, p.pub_date FROM cnipa_patent p ${where} ORDER BY p.pub_date DESC, p.created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, (page - 1) * limit) as Record<string, unknown>[]
  return { items: rows.map(rowToPatentListItem), total, page, limit, total_pages: Math.ceil(total / limit) }
}

function getChildRows<T>(table: string, patentId: string): T[] {
  return db.prepare(`SELECT * FROM ${table} WHERE patent_id = ?`).all(patentId) as T[]
}

export async function getPatentById(id: string): Promise<Patent | null> {
  const row = db.prepare('SELECT * FROM cnipa_patent WHERE id = ?').get(id) as Record<string, unknown> | undefined
  if (!row) return null
  const images: PatentImage[] = []
  const batchId = row.batch_id ? String(row.batch_id) : 'local'
  const docNumber = String(row.doc_number)
  const addImage = (fileName: string, rawKey?: string, isAbstract = false) => {
    const ossKey = rawKey || `patents/${batchId}/${docNumber}/${fileName}`
    images.push({
      id: `${id}:${ossKey}`,
      patent_id: id,
      file_name: fileName || path.basename(ossKey),
      oss_key: ossKey,
      content_type: 'image/jpeg',
      size: 0,
      width: null,
      height: null,
      is_abstract: isAbstract,
      created_at: toDate(row.created_at) || new Date(),
    })
  }
  if (row.abstract_fig_key) {
    addImage(String(row.abstract_fig_key), undefined, true)
  }
  const drawings = parseJson<Record<string, unknown>[]>(row.drawings, [])
  for (const drawing of drawings) {
    const fileName = String(
      drawing.file_name || drawing.file_key || drawing.file || drawing.name || '',
    )
    const rawKey = drawing.oss_key || drawing.key
      ? String(drawing.oss_key || drawing.key)
      : undefined
    if (fileName || rawKey) {
      addImage(
        fileName || path.basename(rawKey || ''),
        rawKey,
        fileName === row.abstract_fig_key,
      )
    }
  }  return {
    id,
    doc_number: String(row.doc_number),
    kind: String(row.kind),
    pub_country: row.pub_country ? String(row.pub_country) : null,
    pub_date: toDate(row.pub_date),
    app_number: row.app_number ? String(row.app_number) : null,
    app_date: toDate(row.app_date),
    app_country: row.app_country ? String(row.app_country) : null,
    app_type: row.app_type ? String(row.app_type) : null,
    title: String(row.title),
    abstract: row.abstract ? String(row.abstract) : null,
    description: parseJson<Record<string, string> | null>(row.description, null),
    claims: row.claims ? String(row.claims) : null,
    status: row.status ? String(row.status) : null,
    abstract_fig_key: row.abstract_fig_key ? String(row.abstract_fig_key) : null,
    images,
    batch_id: row.batch_id ? String(row.batch_id) : null,
    source_file: row.source_file ? String(row.source_file) : null,
    grant_number: row.grant_number ? String(row.grant_number) : null,
    grant_date: toDate(row.grant_date),
    priority_info: parseJson<Record<string, unknown> | null>(row.priority_info, null),
    created_at: toDate(row.created_at) || new Date(),
    updated_at: toDate(row.updated_at) || new Date(),
    applicants: getChildRows('cnipa_patent_applicant', id),
    inventors: (getChildRows<{ name: string }>('cnipa_patent_inventor', id)).map((r) => r.name),
    agents: getChildRows('cnipa_patent_agent', id),
    citations: getChildRows('cnipa_patent_citation', id),
    examiners: (getChildRows<{ name: string }>('cnipa_patent_examiner', id)).map((r) => r.name),
    assignees: getChildRows('cnipa_patent_assignee', id),
    ipc_codes: (getChildRows<{ ipc_code: string }>('cnipa_patent_ipc', id)).map((r) => r.ipc_code),
    claims_structured: getChildRows('cnipa_patent_claim', id),
  }
}

export async function getPatentImageById(id: string): Promise<PatentImage | null> {
  const [patentId, ...rest] = id.split(':')
  const patent = await getPatentById(patentId)
  if (!patent) return null
  const imageId = `${patentId}:${rest.join(':')}`
  return patent.images.find((image) => image.id === imageId) || null
}

export async function addLog(batchCode: string, level: LogLevel, message: string, details?: Record<string, unknown>): Promise<void> {
  db.prepare('INSERT INTO sync_logs (batch_code, level, message, details) VALUES (?, ?, ?, ?)').run(batchCode, level, message, details ? JSON.stringify(details) : null)
}

export async function getLogsByBatch(batchCode: string, limit = 100): Promise<SyncLog[]> {
  const rows = db.prepare('SELECT * FROM sync_logs WHERE batch_code = ? ORDER BY created_at DESC LIMIT ?').all(batchCode, limit) as Record<string, unknown>[]
  return rows.map((row) => ({ id: Number(row.id), batch_code: String(row.batch_code), level: row.level as LogLevel, message: String(row.message), details: parseJson<Record<string, unknown> | null>(row.details, null), created_at: toDate(row.created_at) || new Date() }))
}

export async function getDashboardStats(): Promise<DashboardStats> {
  const patentCounts = db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN kind LIKE 'B%' THEN 1 ELSE 0 END) AS invention, SUM(CASE WHEN kind LIKE 'U%' THEN 1 ELSE 0 END) AS utility_model FROM cnipa_patent").get() as Record<string, number>
  const batchCount = db.prepare('SELECT COUNT(*) AS count FROM sync_batches').get() as { count: number }
  const pendingCount = db.prepare("SELECT COUNT(*) AS count FROM sync_batches WHERE status = 'pending'").get() as { count: number }
  const failedCount = db.prepare("SELECT COUNT(*) AS count FROM sync_batches WHERE status = 'failed'").get() as { count: number }
  const lastSync = db.prepare("SELECT completed_at FROM sync_batches WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 1").get() as { completed_at?: string } | undefined
  return {
    total_batches: Number(batchCount.count || 0),
    total_patents: Number(patentCounts.total || 0),
    invention_patents: Number(patentCounts.invention || 0),
    utility_model_patents: Number(patentCounts.utility_model || 0),
    this_week_patents: Number((db.prepare("SELECT COUNT(*) AS count FROM cnipa_patent WHERE created_at >= date('now','-7 days')").get() as { count: number }).count || 0),
    last_sync_at: toDate(lastSync?.completed_at),
    pending_batches: Number(pendingCount.count || 0),
    failed_batches: Number(failedCount.count || 0),
    total_applicants: Number((db.prepare('SELECT COUNT(*) AS count FROM cnipa_patent_applicant').get() as { count: number }).count || 0),
    total_inventors: Number((db.prepare('SELECT COUNT(*) AS count FROM cnipa_patent_inventor').get() as { count: number }).count || 0),
    total_citations: Number((db.prepare('SELECT COUNT(*) AS count FROM cnipa_patent_citation').get() as { count: number }).count || 0),
  }
}

type RespValue = string | number | null | RespValue[]

function redisUrl(): URL { return new URL(process.env.REDIS_URL || 'redis://localhost:6379/0') }
function enc(parts: string[]): string { return `*${parts.length}\r\n` + parts.map((p) => `$${Buffer.byteLength(p)}\r\n${p}\r\n`).join('') }
class Parser { private o=0; constructor(private b: Buffer) {} parse(): RespValue { const p=String.fromCharCode(this.b[this.o++]); if(p==='+')return this.line(); if(p==='-')throw new Error(this.line()); if(p===':')return Number(this.line()); if(p==='$'){const l=Number(this.line()); if(l<0)return null; const v=this.b.toString('utf8',this.o,this.o+l); this.o+=l+2; return v} if(p==='*'){const l=Number(this.line()); if(l<0)return null; const a:RespValue[]=[]; for(let i=0;i<l;i++)a.push(this.parse()); return a} throw new Error('Bad Redis response') } line(){const e=this.b.indexOf('\r\n',this.o); const v=this.b.toString('utf8',this.o,e); this.o=e+2; return v} }
async function redis(parts: string[]): Promise<RespValue> { const u=redisUrl(); const s=await new Promise<net.Socket>((res,rej)=>{const x=net.createConnection({host:u.hostname,port:Number(u.port||6379)},()=>res(x)); x.once('error',rej); x.setTimeout(5000,()=>x.destroy(new Error('Redis timeout'))) }); try { async function cmd(p:string[]){ s.write(enc(p)); return await new Promise<RespValue>((res,rej)=>{const c:Buffer[]=[]; const d=(x:Buffer)=>{c.push(x); try{const v=new Parser(Buffer.concat(c)).parse(); clean(); res(v)}catch(e){if(e instanceof RangeError)return; clean(); rej(e)}}; const er=(e:Error)=>{clean(); rej(e)}; const clean=()=>{s.off('data',d); s.off('error',er)}; s.on('data',d); s.on('error',er)}) } if(u.password) await cmd(['AUTH', decodeURIComponent(u.password)]); const dbIndex=u.pathname.replace('/',''); if(dbIndex) await cmd(['SELECT', dbIndex]); return await cmd(parts) } finally { s.end() } }
function arrHash(v: RespValue): Record<string,string> { if(!Array.isArray(v))return {}; const h:Record<string,string>={}; for(let i=0;i<v.length;i+=2)h[String(v[i]??'')]=String(v[i+1]??''); return h }
function toClassification(h: Record<string,string>): ClassificationRow { return { code_norm:h.code_norm||'', code:h.code||'', source_code:h.source_code||'', version:h.version||'', section:h.section||null, class_code:h.class_code||null, subclass:h.subclass||null, main_group:h.main_group||null, subgroup:h.subgroup||null, level:h.level?Number(h.level):null, title_en:h.title_en||'', title_zh:h.title_zh||null, title_zh_source:h.title_zh_source||null, source_file:h.source_file||null } }
function matchClass(row: ClassificationRow, q?: string): boolean { if(!q)return true; const n=q.toLowerCase().replace(/\s+/g,''); return [row.code_norm,row.code,row.source_code,row.title_en,row.title_zh||''].some((v)=>v.toLowerCase().replace(/\s+/g,'').includes(n)) }
function sortClass(a: ClassificationRow,b: ClassificationRow): number { return a.code_norm.localeCompare(b.code_norm,'en',{numeric:true}) }
async function redisClassifications(filter: ClassificationFilter): Promise<ClassificationRow[]> { if(filter.type !== 'ipc') return []; const values=await redis(['SMEMBERS','ipc:classification:all']); const codes=Array.isArray(values)?values.map(String):[]; const rows:ClassificationRow[]=[]; for(const code of codes){const row=toClassification(arrHash(await redis(['HGETALL',`ipc:classification:${code}`]))); if(row.code_norm && matchClass(row, filter.q)) rows.push(row)} return rows.sort(sortClass) }

export async function getClassificationList(filter: ClassificationFilter, page = 1, limit = 20): Promise<PaginatedResponse<ClassificationRow>> {
  const rows = await redisClassifications(filter)
  const total = rows.length
  return { items: rows.slice((page-1)*limit, (page-1)*limit+limit), total, page, limit, total_pages: Math.ceil(total / limit) }
}
export async function getClassificationSemanticList(_filter: ClassificationFilter, _limit = 20): Promise<PaginatedResponse<ClassificationSemanticRow>> { throw new Error('Redis local mode does not support semantic classification search') }
function treeNode(row: ClassificationRow, matches = new Set<string>()): ClassificationTreeNode { return { ...row, parent_code_norm:getClassificationParentCodeNorm(row.code_norm), depth:getClassificationDepth(row.code_norm), has_children: !row.main_group || row.subgroup === '00', is_match: matches.has(row.code_norm) } }
export async function getClassificationTree(filter: ClassificationFilter, parentCodeNorm: string | null = null, limit = 100): Promise<ClassificationTreeResponse> {
  const rows = await redisClassifications(filter)
  if (filter.q) {
    const wanted = new Set<string>(); const matches = new Set<string>()
    for (const row of rows.slice(0, limit)) { matches.add(row.code_norm); wanted.add(row.code_norm); for (const a of getClassificationAncestorCodeNorms(row.code_norm)) wanted.add(a) }
    const all = await redisClassifications({ type: filter.type })
    return { items: all.filter((r)=>wanted.has(r.code_norm)).map((r)=>treeNode(r,matches)), total: rows.length, limit, parent_code_norm:null, is_search:true }
  }
  const parent = parentCodeNorm ? normalizeClassificationCodeNorm(parentCodeNorm) : null
  const children = rows.filter((row) => {
    if (!parent) return /^[A-Z]$/.test(row.code_norm)
    const parts = splitClassificationCode(parent)
    if (parent.length === 1) return row.section === parts.section && /^[A-Z]\d{2}$/.test(row.code_norm)
    if (parent.length === 3) return row.class_code === parts.class_code && /^[A-Z]\d{2}[A-Z]$/.test(row.code_norm)
    if (parts.subclass && !parts.main_group) return row.subclass === parts.subclass && !!row.main_group && row.subgroup === '00'
    if (parts.subclass && parts.main_group && parts.subgroup === '00') return row.subclass === parts.subclass && row.main_group === parts.main_group && !!row.subgroup && row.subgroup !== '00'
    return false
  })
  return { items: children.slice(0, limit).map((r)=>treeNode(r)), total: children.length, limit, parent_code_norm: parent, is_search:false }
}

export function getPool(): unknown { return db }
export async function getClient(): Promise<unknown> { return db }


