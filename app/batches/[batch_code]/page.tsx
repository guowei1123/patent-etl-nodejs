'use client'

import { use } from 'react'
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
} from 'lucide-react'
import type { SyncBatch, SyncLog, BatchStatus } from '@/types'
import { cn } from '@/lib/utils'

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
  extracting: { label: '解压中', color: 'text-info', bgColor: 'bg-info/20' },
  parsing: { label: '解析中', color: 'text-info', bgColor: 'bg-info/20' },
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

export default function BatchDetailPage({
  params,
}: {
  params: Promise<{ batch_code: string }>
}) {
  const { batch_code } = use(params)
  const router = useRouter()

  const { data, error, mutate } = useSWR<{
    success: boolean
    data: { batch: SyncBatch; logs: SyncLog[] }
  }>(`/api/batches/${batch_code}`, fetcher, { refreshInterval: 3000 })

  const batch = data?.data?.batch
  const logs = data?.data?.logs || []
  const isLoading = !data && !error
  const isRunning =
    batch &&
    ['downloading', 'extracting', 'parsing', 'importing'].includes(batch.status)

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

  const getProgress = () => {
    if (!batch) return 0
    if (batch.status === 'completed') return 100
    if (batch.status === 'pending' || batch.status === 'failed') return 0

    const stages = ['downloading', 'extracting', 'parsing', 'importing']
    const stageIndex = stages.indexOf(batch.status)
    return Math.min(stageIndex * 25 + 12, 99)
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

  const status = statusConfig[batch.status]

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
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={isRunning}
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
                {isRunning ? (
                  <Loader2
                    className={cn('h-6 w-6 animate-spin', status.color)}
                  />
                ) : batch.status === 'completed' ? (
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

            {/* Progress */}
            {isRunning && (
              <div className="mt-6">
                <div className="mb-2 flex justify-between text-sm">
                  <span className="text-muted-foreground">进度</span>
                  <span className="text-foreground">
                    {Math.round(getProgress())}%
                  </span>
                </div>
                <Progress value={getProgress()} className="h-2" />
              </div>
            )}

            {/* Error Message */}
            {batch.status === 'failed' && batch.error_message && (
              <div className="bg-destructive/10 mt-4 rounded-lg p-4">
                <p className="text-destructive text-sm">
                  {batch.error_message}
                </p>
              </div>
            )}

            {/* Stats */}
            <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div className="bg-secondary/50 rounded-lg p-4">
                <p className="text-2xl font-bold">{batch.total_files}</p>
                <p className="text-muted-foreground text-xs">总文件数</p>
              </div>
              <div className="bg-secondary/50 rounded-lg p-4">
                <p className="text-2xl font-bold">{batch.processed_files}</p>
                <p className="text-muted-foreground text-xs">已处理</p>
              </div>
              <div className="bg-secondary/50 rounded-lg p-4">
                <p className="text-2xl font-bold">{batch.total_patents}</p>
                <p className="text-muted-foreground text-xs">专利总数</p>
              </div>
              <div className="bg-secondary/50 rounded-lg p-4">
                <p className="text-2xl font-bold">{batch.imported_patents}</p>
                <p className="text-muted-foreground text-xs">已导入</p>
              </div>
            </div>
          </CardContent>
        </Card>

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
