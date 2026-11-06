import { z } from 'zod'

export const configSchema = z
  .object({
    stage: z.enum(['metadata', 'text', 'images', 'all']).default('all'),
    excelPath: z.string().trim().default(''),
    descriptionPath: z.string().trim().default(''),
    claimsPath: z.string().trim().default(''),
    pdfPath: z.string().trim().default(''),
    sheet: z.string().trim().default(''),
    columns: z.object({
      publication: z.string().min(1).default('公开(公告)号'),
      application: z.string().min(1).default('申请号'),
      title: z.string().min(1).default('标题(中文)'),
      date: z.string().min(1).default('公开(公告)日'),
      grant: z.string().default('授权公告号'),
      grantDate: z.string().default('授权公告日'),
      abstract: z.string().default('摘要(中文)'),
      applicant: z.string().default('申请人'),
      inventor: z.string().default('发明人'),
      ipc: z.string().default('IPC'),
    }),
    descriptionKey: z.string().min(1).default('公开号'),
    descriptionText: z.string().min(1).default('说明书'),
    claimsKey: z.string().min(1).default('公开号'),
    claimsText: z.string().min(1).default('权利要求'),
    limit: z.number().int().min(0).max(1000000).default(100),
    beforeDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine(
        (value) =>
          !Number.isNaN(Date.parse(value)) &&
          new Date(value).toISOString().slice(0, 10) === value,
      )
      .default('2023-01-01'),
    cleanupApplications: z.boolean().default(true),
    ocr: z.boolean().default(true),
    noDrawingNumbers: z
      .array(z.string().regex(/^CN\d{7,12}[ABCUY]\d?$/))
      .default([]),
  })
  .superRefine((config, context) => {
    const needed =
      config.stage === 'all'
        ? ['excelPath', 'descriptionPath', 'claimsPath', 'pdfPath']
        : config.stage === 'metadata'
          ? ['excelPath']
          : config.stage === 'images'
            ? ['pdfPath']
            : []
    for (const key of needed)
      if (!config[key as 'excelPath'].trim())
        context.addIssue({
          code: 'custom',
          path: [key],
          message: '请填写本阶段来源路径',
        })
    if (
      config.stage === 'text' &&
      !config.descriptionPath &&
      !config.claimsPath
    )
      context.addIssue({
        code: 'custom',
        path: ['descriptionPath'],
        message: '请至少填写一种正文来源',
      })
  })
export type ImportConfig = z.infer<typeof configSchema>
export interface ImportRecord {
  publication: string
  application: string
  kind: string
  date: string
  title: string
  abstract: string
  applicant: string
  inventor: string
  ipc: string
  grant: string
  grantDate: string
  description: string
  claims: string
  raw: Record<string, unknown>
  source: string
  pdfManifest?: string
  metadataPending?: boolean
  status: 'ready' | 'blocked'
  reasons: string[]
}
export interface JobSummary {
  total: number
  ready: number
  blocked: number
  imported: number
  skipped: number
  failed: number
  removedApplications: number
}
export interface HistoryJob {
  id: string
  mode: 'preview' | 'import'
  status: 'pending' | 'processing' | 'completed' | 'failed'
  createdAt: string
  updatedAt: string
  message: string
  processed: number
  config: ImportConfig
  summary: JobSummary
  sample: ImportRecord[]
  pid?: number
}
export const emptySummary = (): JobSummary => ({
  total: 0,
  ready: 0,
  blocked: 0,
  imported: 0,
  skipped: 0,
  failed: 0,
  removedApplications: 0,
})
export function announcementBatch(date: string, kind: string) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !/^[ABCUY]\d?$/.test(kind) ||
    Number.isNaN(Date.parse(date)) ||
    new Date(date).toISOString().slice(0, 10) !== date
  )
    throw new Error('公告日期或种类码无效')
  const prefix = kind.startsWith('A')
    ? 'CN-PA-TXTS-10-A'
    : /^[BC]/.test(kind)
      ? 'CN-PA-TXTS-10-B'
      : 'CN-PA-TXTS-20-U'
  return `${prefix}-${date.replaceAll('-', '')}`
}
