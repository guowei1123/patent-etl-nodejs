'use client'

import { use, useEffect, useState } from 'react'
import useSWR from 'swr'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AppShell } from '@/components/layout/app-shell'
import { Header } from '@/components/layout/header'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { toast } from 'sonner'
import {
  ArrowLeft,
  Trash2,
  Clock,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Info,
  Play,
  Wrench,
  ShieldCheck,
  FolderCheck,
  Activity,
  Timer,
} from 'lucide-react'
import type {
  SyncBatch,
  SyncLog,
  BatchStatus,
  FileDownloadProgress,
  FileDownloadItem,
  PatentImportFailure,
} from '@/types'
import { cn } from '@/lib/utils'
import {
  formatBytes,
  formatSpeed,
  formatDuration,
  formatProgress,
} from '@/lib/format'
import { stepConfig, getProgress } from '@/components/batches/step-config'
import { StepProgressIndicator } from '@/components/batches/step-progress-indicator'

const fetcher = (url: string) => fetch(url).then((res) => res.json())

const statusConfig: Record<
  BatchStatus,
  {
    label: string
    color: string
    bgColor: string
  }
> = {
  pending: {
    label: '待处理',
    color: 'text-muted-foreground',
    bgColor: 'bg-secondary',
  },
  downloading: { label: '下载中', color: 'text-info', bgColor: 'bg-info/20' },
  downloaded: {
    label: '已下载',
    color: 'text-warning',
    bgColor: 'bg-warning/20',
  },
  processing: { label: '处理中', color: 'text-info', bgColor: 'bg-info/20' },
  processed: {
    label: '已处理',
    color: 'text-warning',
    bgColor: 'bg-warning/20',
  },
  importing: { label: '导入中', color: 'text-info', bgColor: 'bg-info/20' },
  completed: {
    label: '已完成',
    color: 'text-success',
    bgColor: 'bg-success/20',
  },
  failed: {
    label: '失败',
    color: 'text-destructive',
    bgColor: 'bg-destructive/20',
  },
}

const logIcons = {
  info: Info,
  warn: AlertCircle,
  error: XCircle,
}

const activeStatuses: BatchStatus[] = ['downloading', 'processing', 'importing']
const optimisticGraceMs = 5000

const stepStatusMap: Record<string, BatchStatus> = {
  download: 'downloading',
  process: 'processing',
  import: 'importing',
}

function isActiveStatus(status?: BatchStatus | null): boolean {
  return !!status && activeStatuses.includes(status)
}

function getNextStep(status: BatchStatus): string | null {
  const map: Record<string, string> = {
    pending: 'download',
    downloaded: 'process',
    processed: 'import',
  }
  return map[status] || null
}

type VerificationType = 'download' | 'extract'

interface VerificationFailure {
  file: string
  reason: string
  expected?: string
  actual?: string
}

interface VerificationResult {
  type: VerificationType
  passed: boolean
  checkedFiles?: number
  issueCount?: number
  failures: VerificationFailure[]
  report?: string
}

function isPatentImportFailure(value: unknown): value is PatentImportFailure {
  if (!value || typeof value !== 'object') return false
  const failure = value as Record<string, unknown>
  return (
    typeof failure.patent_number === 'string' &&
    typeof failure.kind === 'string' &&
    typeof failure.title === 'string' &&
    typeof failure.error === 'string'
  )
}

function isVerificationFailure(value: unknown): value is VerificationFailure {
  if (!value || typeof value !== 'object') return false
  const failure = value as Record<string, unknown>
  return typeof failure.file === 'string' && typeof failure.reason === 'string'
}

function getImportFailures(log: SyncLog): PatentImportFailure[] {
  const failures = log.details?.failures
  if (!Array.isArray(failures)) return []
  return failures.filter(isPatentImportFailure)
}

function getVerificationFailures(log: SyncLog): VerificationFailure[] {
  const failures = log.details?.failures
  if (!Array.isArray(failures)) return []
  return failures.filter(isVerificationFailure)
}

function parseVerificationLog(
  log: SyncLog,
  type: VerificationType,
): VerificationResult | null {
  const message = log.message

  const patterns =
    type === 'download'
      ? {
          passed: [
            /下载完整性检测通过: (\d+) 个文件/,
            /\[手动校验\] 下载文件完整性通过: (\d+) 个文件/,
          ],
          failed: [
            /下载完整性检测失败: (\d+) 个问题/,
            /\[手动校验\] 下载文件完整性失败: (\d+) 个问题/,
          ],
        }
      : {
          passed: [
            /\[(?:自动|手动)校验\] 解压文件 CRC 通过: (\d+) 个文件/,
          ],
          failed: [
            /\[(?:自动|手动)校验\] 解压文件 CRC 失败: (\d+) 个问题/,
          ],
        }

  for (const pattern of patterns.passed) {
    const match = message.match(pattern)
    if (match) {
      return {
        type,
        passed: true,
        checkedFiles: Number(match[1]),
        failures: [],
      }
    }
  }

  for (const pattern of patterns.failed) {
    const match = message.match(pattern)
    if (match) {
      return {
        type,
        passed: false,
        issueCount: Number(match[1]),
        failures: getVerificationFailures(log),
      }
    }
  }

  return null
}

function getLatestVerificationResult(
  logs: SyncLog[],
  type: VerificationType,
): VerificationResult | null {
  for (const log of logs) {
    const result = parseVerificationLog(log, type)
    if (result) return result
  }
  return null
}

function ImportFailureList({
  failures,
}: {
  failures: PatentImportFailure[]
}) {
  if (failures.length === 0) return null

  return (
    <div className="mt-3 flex flex-col gap-2">
      {failures.map((failure, index) => (
        <div
          key={`${failure.patent_number}-${failure.kind}-${index}`}
          className="border-destructive/20 bg-background/60 rounded-md border p-3"
        >
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-foreground text-sm font-medium">
              {failure.patent_number}
            </span>
            <Badge variant="outline" className="h-5 px-1.5 text-[11px]">
              {failure.kind}
            </Badge>
            {failure.source_file && (
              <span className="text-muted-foreground min-w-0 text-xs break-all">
                {failure.source_file}
              </span>
            )}
          </div>
          <p className="text-foreground mt-1 text-xs break-words">
            {failure.title}
          </p>
          <p className="text-destructive mt-2 text-xs whitespace-pre-wrap break-words">
            {failure.error}
          </p>
        </div>
      ))}
    </div>
  )
}

function DownloadFileList({
  files,
  currentFile,
}: {
  files: FileDownloadItem[]
  currentFile?: FileDownloadProgress | null
}) {
  const statusIcon = (status: FileDownloadItem['status']) => {
    switch (status) {
      case 'completed':
        return (
          <CheckCircle2 aria-hidden="true" className="text-success size-3.5" />
        )
      case 'skipped':
        return (
          <CheckCircle2 aria-hidden="true" className="text-success size-3.5" />
        )
      case 'partial':
        return <Clock aria-hidden="true" className="text-warning size-3.5" />
      case 'downloading':
        return <Spinner className="text-info size-3.5" />
      default:
        return (
          <Clock
            aria-hidden="true"
            className="text-muted-foreground size-3.5"
          />
        )
    }
  }

  const completed = files.filter(
    (f) => f.status === 'completed' || f.status === 'skipped',
  ).length

  return (
    <Card className="border-info/30">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-sm font-medium">
          <span className="flex items-center gap-2">
            <FolderCheck aria-hidden="true" className="text-info size-4" />
            文件列表
          </span>
          <div className="flex items-center gap-3">
            {currentFile?.batchEtaSeconds != null && (
              <span className="text-muted-foreground flex items-center gap-1 text-xs">
                <Timer aria-hidden="true" className="size-3" />
                批次剩余 {formatDuration(currentFile.batchEtaSeconds)}
              </span>
            )}
            <span className="text-muted-foreground text-xs">
              {completed} / {files.length} 已完成
            </span>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ScrollArea className="max-h-[480px]">
          <div className="flex flex-col gap-1">
            {files.map((file) => {
              const percent =
                file.fileSize > 0
                  ? Math.min(
                      Math.round((file.bytesDownloaded / file.fileSize) * 100),
                      100,
                    )
                  : 0
              const isActive =
                file.status === 'downloading' &&
                currentFile?.fileName === file.fileName
              return (
                <div
                  key={file.fileName}
                  className={cn(
                    'flex items-center gap-3 rounded-md px-3',
                    file.status === 'downloading' ? 'bg-info/10 py-3' : 'py-2',
                  )}
                >
                  {statusIcon(file.status)}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-foreground truncate font-mono text-xs">
                        {file.fileName}
                      </span>
                      <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                        {file.status === 'downloading'
                          ? formatProgress(file.bytesDownloaded, file.fileSize)
                          : file.status === 'partial'
                            ? formatProgress(
                                file.bytesDownloaded,
                                file.fileSize,
                              )
                            : formatBytes(file.fileSize)}
                      </span>
                    </div>
                    {file.status === 'downloading' && (
                      <div className="mt-1.5 flex flex-col gap-1">
                        <Progress value={percent} className="h-1.5" />
                        <div className="text-muted-foreground flex gap-4 text-xs">
                          <span className="flex items-center gap-1">
                            <Activity aria-hidden="true" className="size-3" />
                            {isActive && currentFile.speedBytesPerSec > 0
                              ? formatSpeed(currentFile.speedBytesPerSec)
                              : '计算中...'}
                          </span>
                          <span className="flex items-center gap-1">
                            <Timer aria-hidden="true" className="size-3" />
                            剩余{' '}
                            {isActive
                              ? (formatDuration(currentFile.fileEtaSeconds) ??
                                '计算中...')
                              : '计算中...'}
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  )
}

export default function BatchDetailPage({
  params,
}: {
  params: Promise<{ batch_code: string }>
}) {
  const { batch_code } = use(params)
  const router = useRouter()
  const [verifying, setVerifying] = useState<'download' | 'extract' | null>(
    null,
  )
  const [cleaning, setCleaning] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [deleteConfirmText, setDeleteConfirmText] = useState('')
  const [optimisticActiveStep, setOptimisticActiveStep] = useState<
    string | null
  >(null)
  const [optimisticSetAt, setOptimisticSetAt] = useState<number>(0)
  const [trustOptimisticStatus, setTrustOptimisticStatus] = useState(false)
  const [verifyResult, setVerifyResult] = useState<VerificationResult | null>(
    null,
  )

  const { data, error, mutate } = useSWR<{
    success: boolean
    data: {
      batch: SyncBatch
      logs: SyncLog[]
      localTemp: {
        path: string
        exists: boolean
        hasFiles: boolean
      }
      localExtract: {
        path: string
        exists: boolean
        hasFiles: boolean
      }
    }
  }>(`/api/batches/${batch_code}`, fetcher, {
    refreshInterval: 0,
  })

  useEffect(() => {
    if (!optimisticActiveStep) return
    const remainingMs = Math.max(
      optimisticGraceMs - (Date.now() - optimisticSetAt),
      0,
    )
    const timer = window.setTimeout(() => {
      setTrustOptimisticStatus(false)
    }, remainingMs)
    return () => window.clearTimeout(timer)
  }, [optimisticActiveStep, optimisticSetAt])

  const dbBatch = data?.data?.batch
  const dbStatusActive = isActiveStatus(dbBatch?.status)
  const shouldPollStatus = !!dbStatusActive || optimisticActiveStep !== null

  // 活跃任务实时轮询：下载阶段带文件进度，导入阶段带已导入计数。
  const { data: statusData } = useSWR<{
    success: boolean
    data: {
      batch: SyncBatch
      is_running: boolean
      progress: number
      current_file: FileDownloadProgress | null
      file_list: FileDownloadItem[] | null
    }
  }>(
    shouldPollStatus ? `/api/sync/status?batch_code=${batch_code}` : null,
    fetcher,
    {
      refreshInterval: 1000,
      onSuccess: (latestData) => {
        const { batch: latestBatch, is_running: isTaskStillRunning } =
          latestData.data
        // 宽限期：乐观状态刚设置 5 秒内，不信任 is_running=false，避免启动竞态
        const inGrace =
          optimisticActiveStep !== null &&
          Date.now() - optimisticSetAt < optimisticGraceMs
        if (
          !isTaskStillRunning &&
          !isActiveStatus(latestBatch.status) &&
          !inGrace
        ) {
          setOptimisticActiveStep(null)
          setTrustOptimisticStatus(false)
          mutate()
        }
      },
    },
  )

  const reportedBatch = statusData?.data?.batch ?? dbBatch
  const optimisticStatus =
    optimisticActiveStep && stepStatusMap[optimisticActiveStep]
  const shouldUseOptimisticStatus =
    reportedBatch &&
    optimisticStatus &&
    !isActiveStatus(reportedBatch.status) &&
    (statusData ? statusData.data.is_running || trustOptimisticStatus : true)
  const batch = shouldUseOptimisticStatus
    ? { ...reportedBatch, status: optimisticStatus }
    : reportedBatch
  const logs = data?.data?.logs || []
  const latestImportFailures =
    logs.map(getImportFailures).find((failures) => failures.length > 0) || []
  const localTemp = data?.data?.localTemp
  const localExtract = data?.data?.localExtract
  const isLoading = !data && !error
  const statusActive = isActiveStatus(batch?.status)
  const actuallyRunning = statusData
    ? statusData.data.is_running || trustOptimisticStatus
    : !!statusActive
  const isRunning = !!statusActive && actuallyRunning
  const isOrphaned = !!statusActive && !actuallyRunning
  const isDownloading = batch?.status === 'downloading'
  const isImporting = batch?.status === 'importing'

  const handleDelete = async () => {
    if (deleteConfirmText !== batch_code) {
      toast.error('请输入完整批次编号后再删除')
      return
    }

    setDeleting(true)
    try {
      const response = await fetch(`/api/batches/${batch_code}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm_batch_code: deleteConfirmText }),
      })
      const result = await response.json()

      if (result.success) {
        const deletedPatents = result.data?.deletedPatents ?? 0
        setDeleteDialogOpen(false)
        setDeleteConfirmText('')
        toast.success(`批次已删除，已删除 ${deletedPatents} 条专利数据`)
        router.push('/batches')
      } else {
        toast.error(result.error || '删除失败')
      }
    } catch {
      toast.error('请求失败')
    } finally {
      setDeleting(false)
    }
  }

  const handleCancel = async () => {
    try {
      const response = await fetch('/api/sync/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batch_code, action: 'cancel' }),
      })
      const result = await response.json()

      if (result.success) {
        toast.success('取消请求已发送')
        mutate()
      } else {
        toast.error(result.error || '取消失败')
      }
    } catch {
      toast.error('请求失败')
    }
  }

  const handleRunStep = async (step: string) => {
    setVerifyResult(null)
    try {
      const response = await fetch('/api/sync/step', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batch_code, step }),
      })
      const result = await response.json()

      if (result.success) {
        toast.success(result.message || '步骤已启动')
        setOptimisticActiveStep(step)
        setOptimisticSetAt(Date.now())
        setTrustOptimisticStatus(true)
        mutate()
      } else {
        setOptimisticActiveStep(null)
        setOptimisticSetAt(0)
        setTrustOptimisticStatus(false)
        toast.error(result.error || '启动失败')
      }
    } catch {
      setOptimisticActiveStep(null)
      setOptimisticSetAt(0)
      setTrustOptimisticStatus(false)
      toast.error('请求失败')
    }
  }

  const handleFix = async () => {
    setVerifyResult(null)
    try {
      const response = await fetch('/api/sync/fix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batch_code }),
      })
      const result = await response.json()

      if (result.success) {
        toast.success('修复成功')
        mutate()
      } else {
        toast.error(result.error || '修复失败')
      }
    } catch {
      toast.error('请求失败')
    }
  }

  const handleVerify = async (type: 'download' | 'extract') => {
    setVerifying(type)
    try {
      const response = await fetch('/api/sync/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batch_code, type }),
      })
      const result = await response.json()

      if (result.success) {
        setVerifyResult(result.data)
        toast[result.data.passed ? 'success' : 'error'](
          result.data.passed
            ? `校验通过: ${result.data.checkedFiles} 个文件`
            : `校验失败: ${result.data.failures.length} 个问题`,
        )
        mutate()
      } else {
        toast.error(result.error || '校验失败')
      }
    } catch {
      toast.error('请求失败')
    } finally {
      setVerifying(null)
    }
  }

  const handleCleanup = async () => {
    setCleaning(true)
    try {
      const response = await fetch('/api/sync/cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batch_code, confirm: true }),
      })
      const result = await response.json()

      if (result.success) {
        setVerifyResult(null)
        toast.success(result.message || '本地文件已清理')
        mutate()
      } else {
        toast.error(result.error || '清理失败')
      }
    } catch {
      toast.error('请求失败')
    } finally {
      setCleaning(false)
    }
  }

  if (isLoading) {
    return (
      <AppShell>
        <div className="flex h-screen items-center justify-center">
          <Spinner className="text-muted-foreground size-8" />
        </div>
      </AppShell>
    )
  }

  if (!batch) {
    return (
      <AppShell>
        <div className="flex h-screen flex-col items-center justify-center">
          <p className="text-muted-foreground">批次不存在</p>
          <Link href="/batches">
            <Button variant="outline" className="mt-4">
              返回列表
            </Button>
          </Link>
        </div>
      </AppShell>
    )
  }

  const status = statusConfig[batch.status] ?? {
    label: batch.status,
    color: 'text-muted-foreground',
    bgColor: 'bg-secondary',
  }
  const nextStep = getNextStep(batch.status)
  const hasLocalTempFiles = localTemp?.hasFiles ?? false
  const hasLocalExtractFiles = localExtract?.hasFiles ?? false
  const latestDownloadVerification = getLatestVerificationResult(
    logs,
    'download',
  )
  const latestExtractVerification = getLatestVerificationResult(logs, 'extract')
  const currentDownloadVerification =
    verifyResult?.type === 'download' ? verifyResult : latestDownloadVerification
  const currentExtractVerification =
    verifyResult?.type === 'extract' ? verifyResult : latestExtractVerification
  const visibleVerifyResults = [
    currentDownloadVerification,
    currentExtractVerification,
  ].filter((result): result is VerificationResult => Boolean(result))
  const canVerifyDownload =
    ['downloaded', 'processing', 'processed', 'failed'].includes(
      batch.status,
    ) &&
    hasLocalTempFiles &&
    currentDownloadVerification?.passed !== true
  const canVerifyExtract =
    ['downloaded', 'processing', 'processed', 'failed'].includes(
      batch.status,
    ) &&
    hasLocalExtractFiles &&
    currentExtractVerification?.passed !== true
  const canCleanupLocal = batch.status === 'completed' && hasLocalTempFiles
  const canConfirmDelete = deleteConfirmText === batch.batch_code && !deleting

  return (
    <AppShell>
      <Header
        title={batch.batch_code}
        description={`${batch.data_type === 'invention' ? '发明授权' : '实用新型授权'} · 创建于 ${new Date(batch.created_at).toLocaleString('zh-CN')}`}
        onRefresh={() => mutate()}
        action={
          <div className="flex gap-2">
            {isRunning && (
              <Button variant="outline" onClick={handleCancel}>
                取消任务
              </Button>
            )}
            {isOrphaned && (
              <Button variant="outline" onClick={handleFix}>
                <Wrench data-icon="inline-start" />
                修复状态
              </Button>
            )}
            <AlertDialog
              open={deleteDialogOpen}
              onOpenChange={(open) => {
                setDeleteDialogOpen(open)
                if (!open) setDeleteConfirmText('')
              }}
            >
              <AlertDialogTrigger asChild>
                <Button variant="destructive" disabled={!!isRunning || deleting}>
                  {deleting ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <Trash2 data-icon="inline-start" />
                  )}
                  删除
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>确认删除该批次？</AlertDialogTitle>
                  <AlertDialogDescription>
                    将删除该批次记录、已导入的数据库专利数据、日志和本地临时文件。删除后如需重新执行
                    ETL，需要重新创建批次。服务端会再次校验输入的批次编号。
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <FieldGroup className="py-2">
                  <Field>
                    <FieldLabel htmlFor="delete-confirm-batch-code">
                      输入批次编号以确认
                    </FieldLabel>
                    <Input
                      id="delete-confirm-batch-code"
                      value={deleteConfirmText}
                      onChange={(event) =>
                        setDeleteConfirmText(event.target.value)
                      }
                      placeholder={batch.batch_code}
                      autoComplete="off"
                      disabled={deleting}
                    />
                    <p className="text-muted-foreground text-xs break-all">
                      需要输入：{batch.batch_code}
                    </p>
                  </Field>
                </FieldGroup>
                <AlertDialogFooter>
                  <AlertDialogCancel>取消</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={(event) => {
                      event.preventDefault()
                      handleDelete()
                    }}
                    disabled={!canConfirmDelete}
                  >
                    确认删除
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        }
      />

      <div className="flex flex-col gap-6 p-6">
        {/* Back Link */}
        <Link
          href="/batches"
          className="text-muted-foreground hover:text-foreground inline-flex items-center text-sm"
        >
          <ArrowLeft aria-hidden="true" className="mr-2 size-4" />
          返回批次列表
        </Link>

        {/* Status Card */}
        <Card className="bg-card border-border">
          <CardContent className="p-6">
            <div className="flex items-center gap-4">
              <div
                className={cn(
                  'flex size-12 items-center justify-center rounded-lg',
                  status.bgColor,
                )}
              >
                {isOrphaned ? (
                  <AlertCircle
                    aria-hidden="true"
                    className="text-warning size-6"
                  />
                ) : isRunning ? (
                  <Spinner className={cn('size-6', status.color)} />
                ) : ['completed', 'downloaded', 'processed'].includes(
                    batch.status,
                  ) ? (
                  <CheckCircle2
                    aria-hidden="true"
                    className={cn('size-6', status.color)}
                  />
                ) : batch.status === 'failed' ? (
                  <XCircle
                    aria-hidden="true"
                    className={cn('size-6', status.color)}
                  />
                ) : (
                  <Clock
                    aria-hidden="true"
                    className={cn('size-6', status.color)}
                  />
                )}
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-semibold">{status.label}</h2>
                  <Badge variant="outline">
                    {batch.data_type === 'invention' ? '发明' : '实用新型'}
                  </Badge>
                </div>
                {batch.ftp_folder && (
                  <p className="text-muted-foreground mt-1 text-sm">
                    FTP: {batch.ftp_folder}
                  </p>
                )}
              </div>
            </div>

            {/* Orphaned State Warning */}
            {isOrphaned && (
              <Alert className="border-warning/40 bg-warning/10 mt-4">
                <AlertCircle aria-hidden="true" className="text-warning" />
                <AlertTitle className="text-warning">任务状态异常</AlertTitle>
                <AlertDescription>
                  数据库状态为「{status.label}
                  」但进程内无对应任务（可能因服务重启导致）。请点击上方「修复状态」按钮重置批次状态。
                </AlertDescription>
              </Alert>
            )}

            {/* Progress */}
            {isRunning && (
              <div className="mt-6">
                <div className="mb-2 flex justify-between text-sm">
                  <span className="text-muted-foreground">进度</span>
                  <span className="text-foreground">
                    {Math.round(getProgress(batch))}%
                  </span>
                </div>
                <Progress value={getProgress(batch)} className="h-2" />
                {isImporting && (
                  <p className="text-muted-foreground mt-2 text-xs">
                    已导入 {batch.imported_patents.toLocaleString()} /{' '}
                    {batch.total_patents.toLocaleString()} 条专利
                  </p>
                )}
              </div>
            )}

            {/* Error Message */}
            {batch.status === 'failed' && batch.error_message && (
              <Alert className="border-destructive/40 bg-destructive/10 mt-4">
                <XCircle aria-hidden="true" className="text-destructive" />
                <AlertTitle className="text-destructive">批次执行失败</AlertTitle>
                <AlertDescription>
                  <p className="text-sm whitespace-pre-wrap">
                  {batch.error_message}
                  </p>
                </AlertDescription>
                <ImportFailureList failures={latestImportFailures} />
              </Alert>
            )}

            {/* Actions Panel */}
            {(!isRunning || isOrphaned) &&
              (nextStep ||
                canVerifyDownload ||
                canVerifyExtract ||
                visibleVerifyResults.length > 0 ||
                canCleanupLocal ||
                batch.status === 'failed' ||
                isOrphaned) && (
                <div className="mt-6 flex flex-col gap-4">
                  <div className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
                    操作
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {nextStep && (
                      <Button onClick={() => handleRunStep(nextStep)}>
                        <Play data-icon="inline-start" />
                        执行{stepConfig.find((s) => s.key === nextStep)?.label}
                      </Button>
                    )}

                    {canVerifyDownload && (
                      <Button
                        variant="outline"
                        onClick={() => handleVerify('download')}
                        disabled={verifying === 'download'}
                      >
                        {verifying === 'download' ? (
                          <Spinner data-icon="inline-start" />
                        ) : (
                          <ShieldCheck data-icon="inline-start" />
                        )}
                        校验下载文件
                      </Button>
                    )}

                    {canVerifyExtract && (
                      <Button
                        variant="outline"
                        onClick={() => handleVerify('extract')}
                        disabled={verifying === 'extract'}
                      >
                        {verifying === 'extract' ? (
                          <Spinner data-icon="inline-start" />
                        ) : (
                          <FolderCheck data-icon="inline-start" />
                        )}
                        校验解压文件
                      </Button>
                    )}

                    {canCleanupLocal && (
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="outline" disabled={cleaning}>
                            {cleaning ? (
                              <Spinner data-icon="inline-start" />
                            ) : (
                              <Trash2 data-icon="inline-start" />
                            )}
                            清理本地文件
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>
                              确认清理本地文件？
                            </AlertDialogTitle>
                            <AlertDialogDescription>
                              将删除该批次的本地下载压缩包、解压目录和
                              parsed.json。数据库中已导入的数据不会被删除。
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>取消</AlertDialogCancel>
                            <AlertDialogAction onClick={handleCleanup}>
                              确认清理
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    )}

                    {(batch.status === 'failed' || isOrphaned) && (
                      <Button variant="outline" onClick={handleFix}>
                        <Wrench data-icon="inline-start" />
                        修复状态
                      </Button>
                    )}
                  </div>

                  {/* Verification Result */}
                  {visibleVerifyResults.length > 0 && (
                    <div className="flex flex-col gap-2">
                      {visibleVerifyResults.map((result) => (
                        <div
                          key={result.type}
                          className={cn(
                            'rounded-lg p-4',
                            result.passed
                              ? 'bg-success/10'
                              : 'bg-destructive/10',
                          )}
                        >
                          <div className="flex items-center gap-2">
                            {result.passed ? (
                              <CheckCircle2
                                aria-hidden="true"
                                className="text-success size-4"
                              />
                            ) : (
                              <XCircle
                                aria-hidden="true"
                                className="text-destructive size-4"
                              />
                            )}
                            <span
                              className={cn(
                                'text-sm font-medium',
                                result.passed
                                  ? 'text-success'
                                  : 'text-destructive',
                              )}
                            >
                              {result.type === 'download'
                                ? '下载文件'
                                : '解压文件'}
                              校验
                              {result.passed ? '通过' : '失败'}
                              {result.checkedFiles !== undefined
                                ? `：已检查 ${result.checkedFiles} 个文件`
                                : result.issueCount !== undefined
                                  ? `：发现 ${result.issueCount} 个问题`
                                  : ''}
                            </span>
                          </div>
                          {result.failures.length > 0 && (
                            <div className="mt-2 flex flex-col gap-1">
                              {result.failures.map((f, i) => (
                                <p
                                  key={i}
                                  className="text-destructive text-xs"
                                >
                                  {f.file}: {f.reason}
                                  {f.expected && f.actual
                                    ? ` (期望: ${f.expected}, 实际: ${f.actual})`
                                    : ''}
                                </p>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

            {/* Step Progress Indicator */}
            <div className="mt-6">
              <StepProgressIndicator status={batch.status} batch={batch} />
            </div>

            {/* Stats */}
            <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
              {[
                'downloading',
                'downloaded',
                'processing',
                'processed',
                'importing',
                'completed',
                'failed',
              ].includes(batch.status) && (
                <div className="bg-secondary/50 rounded-lg p-4">
                  <p className="text-2xl font-bold">{batch.total_files}</p>
                  <p className="text-muted-foreground text-xs">
                    {['downloading'].includes(batch.status)
                      ? '总文件数'
                      : '文件数'}
                  </p>
                </div>
              )}
              {['downloading', 'downloaded', 'completed', 'failed'].includes(
                batch.status,
              ) && (
                <div className="bg-secondary/50 rounded-lg p-4">
                  <p className="text-2xl font-bold">{batch.processed_files}</p>
                  <p className="text-muted-foreground text-xs">
                    {batch.status === 'downloading' ? '已下载' : '已处理文件'}
                  </p>
                </div>
              )}
              {['processed', 'importing', 'completed', 'failed'].includes(
                batch.status,
              ) && (
                <div className="bg-secondary/50 rounded-lg p-4">
                  <p className="text-2xl font-bold">{batch.total_patents}</p>
                  <p className="text-muted-foreground text-xs">专利总数</p>
                </div>
              )}
              {['importing', 'completed', 'failed'].includes(batch.status) && (
                <div className="bg-secondary/50 rounded-lg p-4">
                  <p className="text-2xl font-bold">{batch.imported_patents}</p>
                  <p className="text-muted-foreground text-xs">已导入</p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Download File List */}
        {isDownloading && statusData?.data?.file_list && (
          <DownloadFileList
            files={statusData.data.file_list}
            currentFile={statusData.data.current_file}
          />
        )}

        {/* Logs */}
        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle className="text-base font-medium">同步日志</CardTitle>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-[300px]">
              {logs.length === 0 ? (
                <Empty className="py-8">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <Info aria-hidden="true" />
                    </EmptyMedia>
                    <EmptyTitle>暂无日志</EmptyTitle>
                    <EmptyDescription>
                      批次运行后会在这里显示同步记录。
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <div className="flex flex-col gap-2">
                  {logs.map((log) => {
                    const LogIcon =
                      logIcons[log.level as keyof typeof logIcons] || Info
                    return (
                      <div
                        key={log.id}
                        className={cn(
                          'flex items-start gap-3 rounded-lg p-3',
                          log.level === 'error'
                            ? 'bg-destructive/10'
                            : log.level === 'warn'
                              ? 'bg-warning/10'
                              : 'bg-secondary/30',
                        )}
                      >
                        <LogIcon
                          className={cn(
                            'mt-0.5 size-4',
                            log.level === 'error'
                              ? 'text-destructive'
                              : log.level === 'warn'
                                ? 'text-warning'
                                : 'text-muted-foreground',
                          )}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="text-foreground text-sm">
                            {log.message}
                          </p>
                          <p className="text-muted-foreground mt-1 text-xs">
                            {new Date(log.created_at).toLocaleString('zh-CN')}
                          </p>
                          <ImportFailureList failures={getImportFailures(log)} />
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </ScrollArea>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  )
}
