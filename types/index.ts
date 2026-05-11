// 专利类型
export type PatentType = 'invention' | 'utility_model'

// 批次状态
export type BatchStatus =
  | 'pending'
  | 'downloading'
  | 'extracting'
  | 'parsing'
  | 'importing'
  | 'completed'
  | 'failed'

// 日志级别
export type LogLevel = 'info' | 'warn' | 'error'

// 同步批次
export interface SyncBatch {
  id: number
  batch_code: string
  data_type: PatentType
  ftp_folder: string | null
  status: BatchStatus
  total_files: number
  processed_files: number
  total_patents: number
  imported_patents: number
  error_message: string | null
  started_at: Date | null
  completed_at: Date | null
  created_at: Date
}

// 专利数据
export interface Patent {
  id: number
  batch_id: number
  patent_number: string
  patent_type: PatentType
  title: string
  abstract: string | null
  claims: string | null
  applicant: string | null
  inventor: string | null
  application_number: string | null
  application_date: Date | null
  publication_number: string | null
  publication_date: Date | null
  grant_number: string | null
  grant_date: Date | null
  ipc_codes: string[] | null
  agency: string | null
  agent: string | null
  priority_info: Record<string, unknown> | null
  raw_xml: string | null
  created_at: Date
  updated_at: Date
}

// 同步日志
export interface SyncLog {
  id: number
  batch_id: number
  level: LogLevel
  message: string
  details: Record<string, unknown> | null
  created_at: Date
}

// FTP 文件/文件夹信息
export interface FtpEntry {
  name: string
  type: 'file' | 'directory'
  size: number
  modifiedAt: Date | null
  path: string
}

// FTP 配置
export interface FtpConfig {
  host: string
  port: number
  user: string
  password: string
  secure: boolean
}

// 解析后的专利数据 (用于插入数据库前)
export interface ParsedPatent {
  patent_number: string
  patent_type: PatentType
  title: string
  abstract?: string
  claims?: string
  applicant?: string
  inventor?: string
  application_number?: string
  application_date?: string
  publication_number?: string
  publication_date?: string
  grant_number?: string
  grant_date?: string
  ipc_codes?: string[]
  agency?: string
  agent?: string
  priority_info?: Record<string, unknown>
  raw_xml?: string
}

// ETL 进度回调
export interface ETLProgress {
  stage:
    | 'connecting'
    | 'downloading'
    | 'extracting'
    | 'parsing'
    | 'importing'
    | 'completed'
    | 'failed'
  message: string
  current?: number
  total?: number
  percentage?: number
}

// API 响应
export interface ApiResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
  message?: string
}

// 分页参数
export interface PaginationParams {
  page: number
  limit: number
  sort_by?: string
  sort_order?: 'asc' | 'desc'
}

// 分页响应
export interface PaginatedResponse<T> {
  items: T[]
  total: number
  page: number
  limit: number
  total_pages: number
}

// 专利查询筛选
export interface PatentFilter {
  patent_type?: PatentType
  search?: string
  grant_date_from?: string
  grant_date_to?: string
  batch_id?: number
}

// 仪表盘统计
export interface DashboardStats {
  total_batches: number
  total_patents: number
  invention_patents: number
  utility_model_patents: number
  this_week_patents: number
  last_sync_at: Date | null
  pending_batches: number
  failed_batches: number
}
