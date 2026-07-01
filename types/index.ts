// 专利类型
export type PatentType = 'invention' | 'utility_model'

// 批次状态
export type BatchStatus =
  | 'pending'
  | 'downloading'
  | 'downloaded'
  | 'processing'
  | 'processed'
  | 'importing'
  | 'completed'
  | 'failed'

// 日志级别
export type LogLevel = 'info' | 'warn' | 'error'

// 同步批次
export interface SyncBatch {
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

// 专利数据（对应 cnipa.patent 主表 + 关联子表聚合）
export interface Patent {
  id: string
  doc_number: string
  kind: string
  pub_country: string | null
  pub_date: Date | null
  app_number: string | null
  app_date: Date | null
  app_country: string | null
  app_type: string | null
  title: string
  abstract: string | null
  description: Record<string, string> | null
  claims: string | null
  status: string | null
  abstract_fig_key: string | null
  images: PatentImage[]
  batch_id: string | null
  source_file: string | null
  grant_number: string | null
  grant_date: Date | null
  priority_info: Record<string, unknown> | null
  created_at: Date
  updated_at: Date
  // 子表聚合字段
  applicants: PatentApplicantRow[]
  inventors: string[]
  agents: PatentAgentRow[]
  citations: PatentCitationRow[]
  examiners: string[]
  assignees: PatentApplicantRow[]
  ipc_codes: string[]
  claims_structured: PatentClaimRow[]
}

// 列表视图轻量类型
export interface PatentListItem {
  id: string
  doc_number: string
  kind: string
  title: string
  pub_date: Date | null
  applicants: PatentApplicantRow[]
}

// IPC/CPC 分类字典
export type ClassificationType = 'ipc' | 'cpc'

export interface ClassificationRow {
  code_norm: string
  code: string
  source_code: string
  version: string
  section: string | null
  class_code: string | null
  subclass: string | null
  main_group: string | null
  subgroup: string | null
  level: number | null
  title_en: string
  title_zh: string | null
  title_zh_source: string | null
  source_file: string | null
}

export interface ClassificationFilter {
  type: ClassificationType
  q?: string
}

export interface ClassificationTreeNode extends ClassificationRow {
  parent_code_norm: string | null
  depth: number
  has_children: boolean
  is_match: boolean
}

export interface ClassificationTreeResponse {
  items: ClassificationTreeNode[]
  total: number
  limit: number
  parent_code_norm: string | null
  is_search: boolean
}

// 子表行类型
export interface PatentApplicantRow {
  name: string
  address?: string
  province?: string
  city?: string
  county?: string
  postcode?: string
}

export interface PatentAgentRow {
  agency: string | null
  agent: string | null
}

export interface PatentCitationRow {
  country: string | null
  doc_number: string | null
  kind: string | null
  pub_date: string | null
}

export interface PatentClaimRow {
  claim_num: number
  claim_text: string
}

export interface PatentImage {
  id: string
  patent_id: string
  file_name: string
  oss_key: string
  content_type: string
  size: number
  width: number | null
  height: number | null
  is_abstract: boolean
  created_at: Date
}

export interface ParsedPatentImage {
  file_name: string
  oss_key: string
  content_type: string
  size: number
  width?: number
  height?: number
  is_abstract: boolean
}

export interface PatentImportFailure {
  patent_number: string
  kind: string
  title: string
  source_file: string | null
  error: string
}

export interface PatentImportResult {
  insertedCount: number
  failures: PatentImportFailure[]
}

// 同步日志
export interface SyncLog {
  id: number
  batch_code: string
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
  timeout?: number
}

// 结构化申请人
export interface ParsedApplicant {
  name: string
  address?: string
  province?: string
  city?: string
  county?: string
  postcode?: string
}

// 结构化代理人/机构（保留配对关系）
export interface ParsedAgent {
  agent_name: string
  agency_name: string
}

// 结构化引用文献
export interface ParsedCitation {
  country?: string
  doc_number?: string
  kind?: string
  pub_date?: string
}

// 结构化权利要求
export interface ParsedClaim {
  num: string
  texts: string[]
}

// 结构化说明书
export interface ParsedDescription {
  technical_field?: string
  background_art?: string
  disclosure?: string
  drawings_description?: string
  embodiment?: string
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

  // === 新增字段 ===
  kind?: string
  pub_country?: string
  app_country?: string
  app_type?: string
  doc_status?: string
  source_file?: string
  description?: string
  description_structured?: ParsedDescription
  applicants_structured?: ParsedApplicant[]
  inventors_structured?: string[]
  agents_structured?: ParsedAgent[]
  citations?: ParsedCitation[]
  examiners?: string[]
  assignees?: ParsedApplicant[]
  ipc_structured?: string[]
  claims_structured?: ParsedClaim[]
  abstract_figure?: string
  image_files?: string[]
  images?: ParsedPatentImage[]
}

// ETL 进度回调
export interface ETLProgress {
  stage:
    | 'connecting'
    | 'downloading'
    | 'downloaded'
    | 'processing'
    | 'processed'
    | 'importing'
    | 'completed'
    | 'failed'
  message: string
  current?: number
  total?: number
  percentage?: number
}

// 单文件下载进度
export interface FileDownloadProgress {
  fileName: string
  bytesDownloaded: number
  totalBytes: number
  speedBytesPerSec: number // 滑动窗口速度，0 = 计算中
  fileEtaSeconds: number | null // 当前文件剩余秒数
  batchEtaSeconds: number | null // 整个批次下载剩余秒数
}

// 文件列表中单个文件的下载状态
export type FileDownloadStatus =
  | 'pending'
  | 'partial'
  | 'downloading'
  | 'completed'
  | 'skipped'

export interface FileDownloadItem {
  fileName: string
  fileSize: number
  status: FileDownloadStatus
  bytesDownloaded: number
}

export type ProcessProgressPhase =
  | 'preparing'
  | 'parsing_xml'
  | 'uploading_images'

export interface ProcessProgress {
  batchCode: string
  currentZip: string | null
  phase: ProcessProgressPhase
  processedZips: number
  totalZips: number
  xmlProcessed: number
  patentCount: number
  imageTotal: number
  imageUploaded: number
  imageSkipped: number
  imageFailed: number
  updatedAt: number
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
  kind?: string
  app_type?: string
  search?: string
  expression?: string
  pub_date_from?: string
  pub_date_to?: string
  batch_id?: string
  province?: string
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
  total_applicants: number
  total_inventors: number
  total_citations: number
}
