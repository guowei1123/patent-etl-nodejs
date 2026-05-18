'use client'

import { use, useRef, useState } from 'react'
import useSWR from 'swr'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AppShell } from '@/components/layout/app-shell'
import { Header } from '@/components/layout/header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import { toast } from 'sonner'
import {
  ArrowLeft,
  Trash2,
  Clock,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Info,
  Loader2,
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

function getNextStep(status: BatchStatus): string | null {
  const map: Record<string, string> = {
    pending: 'download',
    downloaded: 'process',
    processed: 'import',
  }
  return map[status] || null
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
        return <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
      case 'skipped':
        return <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
      case 'downloading':
        return <Loader2 className="text-info h-3.5 w-3.5 animate-spin" />
      default:
        return <Clock className="text-muted-foreground h-3.5 w-3.5" />
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
            <FolderCheck className="text-info h-4 w-4" />
            文件列表
          </span>
          <div className="flex items-center gap-3">
            {currentFile?.batchEtaSeconds != null && (
              <span className="text-muted-foreground flex items-center gap-1 text-xs">
                <Timer className="h-3 w-3" />
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
          <div className="space-y-1">
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
                          : formatBytes(file.fileSize)}
                      </span>
                    </div>
                    {file.status === 'downloading' && (
                      <div className="mt-1.5 space-y-1">
                        <Progress value={percent} className="h-1.5" />
                        <div className="text-muted-foreground flex gap-4 text-xs">
                          <span className="flex items-center gap-1">
                            <Activity className="h-3 w-3" />
                            {isActive && currentFile.speedBytesPerSec > 0
                              ? formatSpeed(currentFile.speedBytesPerSec)
                              : '计算中...'}
                          </span>
                          <span className="flex items-center gap-1">
                            <Timer className="h-3 w-3" />
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
  const runningRef = useRef(false)
  const [verifying, setVerifying] = useState<'download' | 'extract' | null>(
    null,
  )
  const [verifyResult, setVerifyResult] = useState<{
    type: 'download' | 'extract'
    passed: boolean
    checkedFiles: number
    failures: {
      file: string
      reason: string
      expected?: string
      actual?: string
    }[]
    report: string
  } | null>(null)

  const { data, error, mutate } = useSWR<{
    success: boolean
    data: { batch: SyncBatch; logs: SyncLog[] }
  }>(`/api/batches/${batch_code}`, fetcher, {
    refreshInterval: runningRef.current ? 3000 : 0,
  })

  // 下载进度实时轮询（仅下载中激活，1 秒间隔）
  const [isDownloading, setIsDownloading] = useState(false)
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
    isDownloading ? `/api/sync/status?batch_code=${batch_code}` : null,
    fetcher,
    { refreshInterval: 1000 },
  )

  // 额外轮询：当数据库状态为活跃时，检查任务是否真正在运行（检测孤儿状态）
  const [needStatusCheck, setNeedStatusCheck] = useState(false)
  const { data: orphanCheckData } = useSWR<{
    success: boolean
    data: { is_running: boolean }
  }>(
    needStatusCheck && !isDownloading
      ? `/api/sync/status?batch_code=${batch_code}`
      : null,
    fetcher,
    { refreshInterval: 3000 },
  )

  const batch = data?.data?.batch
  const logs = data?.data?.logs || []
  const isLoading = !data && !error
  const statusActive =
    batch && ['downloading', 'processing', 'importing'].includes(batch.status)
  const actuallyRunning = isDownloading
    ? (statusData?.data?.is_running ?? false)
    : (orphanCheckData?.data?.is_running ?? !!statusActive)
  const isRunning = !!statusActive && actuallyRunning
  const isOrphaned = !!statusActive && !actuallyRunning
  runningRef.current = !!statusActive

  // 同步下载状态到第二个 SWR hook 的条件 key
  if (batch?.status === 'downloading' && !isDownloading) setIsDownloading(true)
  if (batch?.status !== 'downloading' && isDownloading) setIsDownloading(false)
  // 活跃状态时启用孤儿检测轮询
  if (statusActive && !needStatusCheck) setNeedStatusCheck(true)
  if (!statusActive && needStatusCheck) setNeedStatusCheck(false)

  const handleDelete = async () => {
    if (!confirm('确定要删除这个批次吗？相关的专利数据也将被删除。')) return

    try {
      const response = await fetch(`/api/batches/${batch_code}`, {
        method: 'DELETE',
      })
      const result = await response.json()

      if (result.success) {
        toast.success('批次已删除')
        router.push('/batches')
      } else {
        toast.error(result.error || '删除失败')
      }
    } catch {
      toast.error('请求失败')
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
        if (step === 'download') setIsDownloading(true)
        mutate()
      } else {
        toast.error(result.error || '启动失败')
      }
    } catch {
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

  if (isLoading) {
    return (
      <AppShell>
        <div className="flex h-screen items-center justify-center">
          <Loader2 className="text-muted-foreground h-8 w-8 animate-spin" />
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
  const canVerifyDownload = [
    'downloaded',
    'processing',
    'processed',
    'completed',
    'failed',
  ].includes(batch.status)
  const canVerifyExtract = [
    'downloaded',
    'processing',
    'processed',
    'completed',
    'failed',
  ].includes(batch.status)

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
                <Wrench className="mr-2 h-4 w-4" />
                修复状态
              </Button>
            )}
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={!!isRunning}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              删除
            </Button>
          </div>
        }
      />

      <div className="space-y-6 p-6">
        {/* Back Link */}
        <Link
          href="/batches"
          className="text-muted-foreground hover:text-foreground inline-flex items-center text-sm"
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          返回批次列表
        </Link>

        {/* Status Card */}
        <Card className="bg-card border-border">
          <CardContent className="p-6">
            <div className="flex items-center gap-4">
              <div
                className={cn(
                  'flex h-12 w-12 items-center justify-center rounded-lg',
                  status.bgColor,
                )}
              >
                {isOrphaned ? (
                  <AlertCircle className={cn('text-warning h-6 w-6')} />
                ) : isRunning ? (
                  <Loader2
                    className={cn('h-6 w-6 animate-spin', status.color)}
                  />
                ) : ['completed', 'downloaded', 'processed'].includes(
                    batch.status,
                  ) ? (
                  <CheckCircle2 className={cn('h-6 w-6', status.color)} />
                ) : batch.status === 'failed' ? (
                  <XCircle className={cn('h-6 w-6', status.color)} />
                ) : (
                  <Clock className={cn('h-6 w-6', status.color)} />
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
              <div className="bg-warning/10 mt-4 rounded-lg p-4">
                <div className="flex items-center gap-2">
                  <AlertCircle className="text-warning h-4 w-4" />
                  <span className="text-warning text-sm font-medium">
                    任务状态异常
                  </span>
                </div>
                <p className="text-muted-foreground mt-1 text-sm">
                  数据库状态为「{status.label}
                  」但进程内无对应任务（可能因服务重启导致）。请点击上方「修复状态」按钮重置批次状态。
                </p>
              </div>
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
              </div>
            )}

            {/* Error Message */}
            {batch.status === 'failed' && batch.error_message && (
              <div className="bg-destructive/10 mt-4 rounded-lg p-4">
                <p className="text-destructive text-sm whitespace-pre-wrap">
                  {batch.error_message}
                </p>
              </div>
            )}

            {/* Actions Panel */}
            {(!isRunning || isOrphaned) &&
              (nextStep ||
                canVerifyDownload ||
                canVerifyExtract ||
                batch.status === 'failed' ||
                isOrphaned) && (
                <div className="mt-6 space-y-4">
                  <div className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
                    操作
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {nextStep && (
                      <Button onClick={() => handleRunStep(nextStep)}>
                        <Play className="mr-2 h-4 w-4" />
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
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          <ShieldCheck className="mr-2 h-4 w-4" />
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
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          <FolderCheck className="mr-2 h-4 w-4" />
                        )}
                        校验解压文件
                      </Button>
                    )}

                    {(batch.status === 'failed' || isOrphaned) && (
                      <Button variant="outline" onClick={handleFix}>
                        <Wrench className="mr-2 h-4 w-4" />
                        修复状态
                      </Button>
                    )}
                  </div>

                  {/* Verification Result */}
                  {verifyResult && (
                    <div
                      className={cn(
                        'rounded-lg p-4',
                        verifyResult.passed
                          ? 'bg-success/10'
                          : 'bg-destructive/10',
                      )}
                    >
                      <div className="flex items-center gap-2">
                        {verifyResult.passed ? (
                          <CheckCircle2 className="text-success h-4 w-4" />
                        ) : (
                          <XCircle className="text-destructive h-4 w-4" />
                        )}
                        <span
                          className={cn(
                            'text-sm font-medium',
                            verifyResult.passed
                              ? 'text-success'
                              : 'text-destructive',
                          )}
                        >
                          {verifyResult.type === 'download'
                            ? '下载文件'
                            : '解压文件'}
                          校验
                          {verifyResult.passed ? '通过' : '失败'}
                          ：已检查 {verifyResult.checkedFiles} 个文件
                        </span>
                      </div>
                      {verifyResult.failures.length > 0 && (
                        <div className="mt-2 space-y-1">
                          {verifyResult.failures.map((f, i) => (
                            <p key={i} className="text-destructive text-xs">
                              {f.file}: {f.reason}
                              {f.expected && f.actual
                                ? ` (期望: ${f.expected}, 实际: ${f.actual})`
                                : ''}
                            </p>
                          ))}
                        </div>
                      )}
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
                <p className="text-muted-foreground py-8 text-center text-sm">
                  暂无日志
                </p>
              ) : (
                <div className="space-y-2">
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
                            'mt-0.5 h-4 w-4',
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
