// 涓撳埄绫诲瀷
export type PatentType = 'invention' | 'utility_model'

// 鎵规鐘舵€?
export type BatchStatus =
  | 'pending'
  | 'downloading'
  | 'downloaded'
  | 'processing'
  | 'processed'
  | 'importing'
  | 'completed'
  | 'failed'

// 鏃ュ織绾у埆
export type LogLevel = 'info' | 'warn' | 'error'

// 鍚屾鎵规
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

// 涓撳埄鏁版嵁锛堝搴?cnipa.patent 涓昏〃 + 鍏宠仈瀛愯〃鑱氬悎锛?
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
  lang: string | null
  abstract_fig_key: string | null
  images: PatentImage[]
  batch_id: string | null
  source_file: string | null
  grant_number: string | null
  grant_date: Date | null
  priority_info: Record<string, unknown> | null
  claim_count: number | null
  independent_claim_count: number | null
  created_at: Date
  updated_at: Date
  // 瀛愯〃鑱氬悎瀛楁
  applicants: PatentApplicantRow[]
  inventors: string[]
  agents: PatentAgentRow[]
  citations: PatentCitationRow[]
  examiners: string[]
  assignees: PatentApplicantRow[]
  ipc_codes: string[]
  claims_structured: PatentClaimRow[]
}

// 鍒楄〃瑙嗗浘杞婚噺绫诲瀷
export interface PatentListItem {
  id: string
  doc_number: string
  kind: string
  title: string
  pub_date: Date | null
  applicants: PatentApplicantRow[]
}

// IPC/CPC 鍒嗙被瀛楀吀
export type ClassificationType = 'ipc' | 'cpc'
export type ClassificationSearchMode = 'keyword' | 'semantic'
export type ClassificationEmbeddingLocale = 'en' | 'zh' | 'mixed'

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

export interface ClassificationSemanticRow extends ClassificationRow {
  similarity: number
  similarity_percent: string
  embedding_model: string
  embedding_locale: ClassificationEmbeddingLocale
  embedding_dimensions: number
  content_hash: string
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

// 瀛愯〃琛岀被鍨?
export interface PatentApplicantRow {
  name: string
  address?: string
  province?: string
  city?: string
  county?: string
  postcode?: string
  country?: string
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
  is_independent?: boolean
}

export interface PatentImage {
  id: string
  patent_id: string
  asset_id: string | null
  file_name: string
  oss_key: string
  content_hash: string | null
  perceptual_hash: string | null
  content_type: string
  size: number
  width: number | null
  height: number | null
  is_abstract: boolean
  image_role: 'abstract' | 'drawing' | 'inline'
  figure_label: string | null
  source_section: string | null
  display_rotation: number
  match_method: string | null
  match_score: number | null
  matched_file_name: string | null
  created_at: Date
}

export interface ParsedPatentImage {
  file_name: string
  oss_key: string
  content_hash?: string
  perceptual_hash?: string
  content_type: string
  size: number
  width?: number
  height?: number
  is_abstract: boolean
  image_role?: 'abstract' | 'drawing' | 'inline'
  figure_label?: string
  source_section?: string
  display_rotation?: number
  match_method?: string
  match_score?: number
  matched_file_name?: string
}

export interface ParsedPatentImageReference {
  file_name: string
  image_role: 'drawing' | 'inline'
  figure_label?: string
  source_section?: string
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

// 鍚屾鏃ュ織
export interface SyncLog {
  id: number
  batch_code: string
  level: LogLevel
  message: string
  details: Record<string, unknown> | null
  created_at: Date
}

// FTP 鏂囦欢/鏂囦欢澶逛俊鎭?
export interface FtpEntry {
  name: string
  type: 'file' | 'directory'
  size: number
  modifiedAt: Date | null
  path: string
}

// FTP 閰嶇疆
export interface FtpConfig {
  host: string
  port: number
  user: string
  password: string
  secure: boolean
  timeout?: number
}

// 缁撴瀯鍖栫敵璇蜂汉
export interface ParsedApplicant {
  name: string
  address?: string
  province?: string
  city?: string
  county?: string
  postcode?: string
  country?: string
}

// 缁撴瀯鍖栦唬鐞嗕汉/鏈烘瀯锛堜繚鐣欓厤瀵瑰叧绯伙級
export interface ParsedAgent {
  agent_name: string
  agency_name: string
}

// 缁撴瀯鍖栧紩鐢ㄦ枃鐚?
export interface ParsedCitation {
  country?: string
  doc_number?: string
  kind?: string
  pub_date?: string
}

// 缁撴瀯鍖栨潈鍒╄姹?
export interface ParsedClaim {
  num: string
  texts: string[]
  is_independent?: boolean
}

// 缁撴瀯鍖栬鏄庝功
export interface ParsedDescription {
  technical_field?: string
  background_art?: string
  disclosure?: string
  technical_problem?: string
  technical_solution?: string
  beneficial_effect?: string
  drawings_description?: string
  embodiment?: string
  referenced_documents?: string[]
}

// 瑙ｆ瀽鍚庣殑涓撳埄鏁版嵁 (鐢ㄤ簬鎻掑叆鏁版嵁搴撳墠)
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

  // === 鏂板瀛楁 ===
  kind?: string
  pub_country?: string
  app_country?: string
  app_type?: string
  doc_status?: string
  lang?: string
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
  claim_count?: number
  independent_claim_count?: number
  abstract_figure?: string
  image_files?: string[]
  image_references?: ParsedPatentImageReference[]
  images?: ParsedPatentImage[]
}

// ETL 杩涘害鍥炶皟
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

// 鍗曟枃浠朵笅杞借繘搴?
export interface FileDownloadProgress {
  fileName: string
  bytesDownloaded: number
  totalBytes: number
  speedBytesPerSec: number // 婊戝姩绐楀彛閫熷害锛? = 璁＄畻涓?
  fileEtaSeconds: number | null // 褰撳墠鏂囦欢鍓╀綑绉掓暟
  batchEtaSeconds: number | null // 鏁翠釜鎵规涓嬭浇鍓╀綑绉掓暟
}

// 鏂囦欢鍒楄〃涓崟涓枃浠剁殑涓嬭浇鐘舵€?
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
  | 'verifying_crc'
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

// API 鍝嶅簲
export interface ApiResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
  message?: string
}

// 鍒嗛〉鍙傛暟
export interface PaginationParams {
  page: number
  limit: number
  sort_by?: string
  sort_order?: 'asc' | 'desc'
}

// 鍒嗛〉鍝嶅簲
export interface PaginatedResponse<T> {
  items: T[]
  total: number
  page: number
  limit: number
  total_pages: number
}

// 涓撳埄鏌ヨ绛涢€?
export interface PatentFilter {
  kind?: string
  app_type?: string
  search?: string
  expression?: string
  pub_date_from?: string
  pub_date_to?: string
  batch_id?: string
  province?: string
  ipc?: string
}

// 浠〃鐩樼粺璁?
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
