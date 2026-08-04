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
  PatentImage,
  PatentImportResult,
  ClassificationFilter,
  ClassificationRow,
  ClassificationSemanticRow,
  ClassificationTreeResponse,
} from '@/types'
import {
  isRedisClassificationsConfigured,
  getClassificationListFromRedis,
  getClassificationTreeFromRedis,
} from './redis-classifications'

let dbModulePromise: Promise<typeof import('./pg-db')> | null = null

function getDbModule(): Promise<typeof import('./pg-db')> {
  if (!dbModulePromise) {
    dbModulePromise = import('./pg-db')
  }
  return dbModulePromise
}

export function isDbConfigured(): boolean {
  return !!(
    process.env.DATABASE_URL ||
    (process.env.CNIPA_PG_HOST && process.env.CNIPA_PG_USER)
  )
}

export async function testConnection(): Promise<{ success: boolean; error?: string }> {
  const mod = await getDbModule()
  return mod.testConnection()
}

export async function initializeDatabase(): Promise<void> {
  const mod = await getDbModule()
  return mod.initializeDatabase()
}

export async function createBatch(batchCode: string, dataType: PatentType, ftpFolder?: string): Promise<SyncBatch> {
  const mod = await getDbModule()
  return mod.createBatch(batchCode, dataType, ftpFolder)
}

export async function getBatchByCode(code: string): Promise<SyncBatch | null> {
  const mod = await getDbModule()
  return mod.getBatchByCode(code)
}

export async function getBatchByFtpFolder(ftpFolder: string): Promise<SyncBatch | null> {
  const mod = await getDbModule()
  return mod.getBatchByFtpFolder(ftpFolder)
}

export async function getAllBatches(page?: number, limit?: number, status?: BatchStatus, activeOnly?: boolean): Promise<PaginatedResponse<SyncBatch>> {
  const mod = await getDbModule()
  return mod.getAllBatches(page, limit, status, activeOnly)
}

export async function updateBatchStatus(batchCode: string, status: BatchStatus, errorMessage?: string): Promise<void> {
  const mod = await getDbModule()
  return mod.updateBatchStatus(batchCode, status, errorMessage)
}

export async function updateBatchProgress(batchCode: string, totalFiles?: number, processedFiles?: number, totalPatents?: number, importedPatents?: number): Promise<void> {
  const mod = await getDbModule()
  return mod.updateBatchProgress(batchCode, totalFiles, processedFiles, totalPatents, importedPatents)
}

export async function countImportedPatentsByBatch(batchCode: string): Promise<number> {
  const mod = await getDbModule()
  return mod.countImportedPatentsByBatch(batchCode)
}

export async function getImportedPatentKeysByBatch(batchCode: string): Promise<Set<string>> {
  const mod = await getDbModule()
  return mod.getImportedPatentKeysByBatch(batchCode)
}

export async function deleteBatch(batchCode: string): Promise<{ deleted: boolean }> {
  const mod = await getDbModule()
  return mod.deleteBatch(batchCode)
}

export async function insertPatents(batchCode: string, patents: ParsedPatent[]): Promise<PatentImportResult> {
  const mod = await getDbModule()
  return mod.insertPatents(batchCode, patents)
}

export async function getClassificationList(
  filter: ClassificationFilter,
  page?: number,
  limit?: number,
): Promise<PaginatedResponse<ClassificationRow>> {
  if (isRedisClassificationsConfigured()) {
    return getClassificationListFromRedis(filter, page, limit)
  }
  const mod = await getDbModule()
  return mod.getClassificationList(filter, page, limit)
}

export async function getClassificationSemanticList(
  filter: ClassificationFilter,
  limit?: number,
): Promise<PaginatedResponse<ClassificationSemanticRow>> {
  const mod = await getDbModule()
  return mod.getClassificationSemanticList(filter, limit)
}

export async function getClassificationTree(
  filter: ClassificationFilter,
  parentCodeNorm?: string | null,
  limit?: number,
): Promise<ClassificationTreeResponse> {
  if (isRedisClassificationsConfigured()) {
    return getClassificationTreeFromRedis(filter, parentCodeNorm, limit)
  }
  const mod = await getDbModule()
  return mod.getClassificationTree(filter, parentCodeNorm, limit)
}

export async function getPatentList(
  filter: PatentFilter,
  page?: number,
  limit?: number,
): Promise<PaginatedResponse<PatentListItem>> {
  const mod = await getDbModule()
  return mod.getPatentList(filter, page, limit)
}

export async function getPatentById(id: string): Promise<Patent | null> {
  const mod = await getDbModule()
  return mod.getPatentById(id)
}

export async function getPatentImageById(id: string): Promise<PatentImage | null> {
  const mod = await getDbModule()
  return mod.getPatentImageById(id)
}

export async function addLog(
  batchCode: string,
  level: LogLevel,
  message: string,
  details?: Record<string, unknown>,
): Promise<void> {
  const mod = await getDbModule()
  return mod.addLog(batchCode, level, message, details)
}

export async function getLogsByBatch(batchCode: string, limit?: number): Promise<SyncLog[]> {
  const mod = await getDbModule()
  return mod.getLogsByBatch(batchCode, limit)
}

export async function getDashboardStats(): Promise<DashboardStats> {
  const mod = await getDbModule()
  return mod.getDashboardStats()
}

export async function getPool() {
  const mod = await getDbModule()
  return mod.getPool()
}

export async function getClient() {
  const mod = await getDbModule()
  return mod.getClient()
}
