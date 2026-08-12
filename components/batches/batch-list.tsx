'use client'

import Link from 'next/link'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import {
  ChevronRight,
  Clock,
  CheckCircle2,
  XCircle,
  Download,
  FileSearch,
  Database,
} from 'lucide-react'
import type { SyncBatch, BatchStatus } from '@/types'
import { cn } from '@/lib/utils'
import { StepProgressIndicator } from './step-progress-indicator'
import { getProgress } from './step-config'

interface BatchListProps {
  batches: SyncBatch[]
  showAll?: boolean
}

const statusConfig: Record<
  BatchStatus,
  {
    label: string
    icon: typeof Clock
    variant: 'default' | 'secondary' | 'destructive' | 'outline'
    color: string
  }
> = {
  pending: {
    label: '待处理',
    icon: Clock,
    variant: 'secondary',
    color: 'text-muted-foreground',
  },
  downloading: {
    label: '下载中',
    icon: Download,
    variant: 'default',
    color: 'text-info',
  },
  downloaded: {
    label: '已下载',
    icon: CheckCircle2,
    variant: 'outline',
    color: 'text-warning',
  },
  processing: {
    label: '处理中',
    icon: FileSearch,
    variant: 'default',
    color: 'text-info',
  },
  processed: {
    label: '已处理',
    icon: CheckCircle2,
    variant: 'outline',
    color: 'text-warning',
  },
  importing: {
    label: '导入中',
    icon: Database,
    variant: 'default',
    color: 'text-info',
  },
  completed: {
    label: '已完成',
    icon: CheckCircle2,
    variant: 'outline',
    color: 'text-success',
  },
  failed: {
    label: '失败',
    icon: XCircle,
    variant: 'destructive',
    color: 'text-destructive',
  },
}

const dataTypeLabels: Record<string, string> = {
  invention: '发明授权',
  invention_application: '发明申请',
  utility_model: '实用新型',
}

export function BatchList({ batches, showAll = false }: BatchListProps) {
  const displayBatches = showAll ? batches : batches.slice(0, 5)

  if (batches.length === 0) {
    return (
      <Card className="bg-card/92 border-border/80 shadow-xs">
        <CardContent className="flex flex-col items-center justify-center py-12">
          <div className="bg-secondary/75 flex size-12 items-center justify-center rounded-full border">
            <Clock className="text-muted-foreground size-6" aria-hidden="true" />
          </div>
          <p className="text-muted-foreground mt-4 text-sm">暂无批次记录</p>
          <Button className="mt-4" size="sm" asChild>
            <Link href="/">创建新批次</Link>
          </Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="bg-card/92 border-border/80 overflow-hidden shadow-xs">
      <CardHeader className="border-border/70 flex flex-row items-center justify-between border-b pb-4">
        <div>
          <CardTitle className="text-base font-medium">
            {showAll ? '同步批次' : '最近批次'}
          </CardTitle>
          <CardDescription className="mt-1">
            下载、解析、导入三个阶段的流水线状态
          </CardDescription>
        </div>
        {!showAll && batches.length > 5 && (
          <Link href="/batches">
            <Button variant="ghost" size="sm" className="text-muted-foreground">
              查看全部
              <ChevronRight data-icon="inline-end" aria-hidden="true" />
            </Button>
          </Link>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-3 p-4">
        {displayBatches.map((batch) => {
          const status = statusConfig[batch.status] ?? {
            label: batch.status,
            icon: Clock,
            variant: 'secondary' as const,
            color: 'text-muted-foreground',
          }
          const StatusIcon = status.icon
          const progress = getProgress(batch)
          const isRunning = ['downloading', 'processing', 'importing'].includes(
            batch.status,
          )
          const hasImportProgress =
            batch.total_patents > 0 &&
            (batch.status === 'importing' ||
              (batch.status === 'failed' && batch.imported_patents > 0))

          return (
            <Link
              key={batch.batch_code}
              href={`/batches/${batch.batch_code}`}
              className="block"
            >
              <div className="group border-border/80 bg-background/72 hover:bg-accent/55 relative overflow-hidden rounded-lg border p-4 transition-colors">
                <div
                  className={cn(
                    'absolute inset-y-0 left-0 w-1',
                    batch.status === 'completed'
                      ? 'bg-success'
                      : batch.status === 'failed'
                        ? 'bg-destructive'
                        : isRunning
                          ? 'bg-info'
                          : ['downloaded', 'processed'].includes(batch.status)
                            ? 'bg-warning'
                            : 'bg-muted',
                  )}
                />
                <div className="flex flex-col gap-3 pl-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                  <div className="flex min-w-0 items-center gap-3">
                    <div
                      className={cn(
                        'flex size-9 shrink-0 items-center justify-center rounded-lg border',
                        batch.status === 'completed'
                          ? 'border-success/25 bg-success/16'
                          : batch.status === 'failed'
                            ? 'border-destructive/25 bg-destructive/16'
                            : isRunning
                              ? 'border-info/25 bg-info/16'
                              : ['downloaded', 'processed'].includes(
                                    batch.status,
                                  )
                                ? 'border-warning/25 bg-warning/16'
                                : 'bg-secondary/75',
                      )}
                    >
                      {isRunning ? (
                        <Spinner className={cn('size-4', status.color)} />
                      ) : (
                        <StatusIcon
                          className={cn('size-4', status.color)}
                          aria-hidden="true"
                        />
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="text-foreground truncate text-sm font-medium">
                        {batch.batch_code}
                      </p>
                      <p className="text-muted-foreground text-xs">
                        {dataTypeLabels[batch.data_type]} ·{' '}
                        {new Date(batch.created_at).toLocaleDateString('zh-CN')}
                      </p>
                    </div>
                  </div>

                  <div className="flex w-full shrink-0 items-center justify-between gap-3 sm:w-auto sm:justify-end">
                    <Badge variant={status.variant}>{status.label}</Badge>
                    <StepProgressIndicator
                      status={batch.status}
                      compact
                      batch={batch}
                    />
                    <ChevronRight
                      className="text-muted-foreground size-4 opacity-0 transition-opacity group-hover:opacity-100"
                      aria-hidden="true"
                    />
                  </div>
                </div>

                {isRunning && (
                  <div className="mt-3 pl-2">
                    <div className="text-muted-foreground mb-1 flex items-center justify-between text-xs">
                      <span>
                        {batch.status === 'importing'
                          ? `已导入 ${batch.imported_patents.toLocaleString()} / ${batch.total_patents.toLocaleString()}`
                          : '进度'}
                      </span>
                      <span>{Math.round(progress)}%</span>
                    </div>
                    <Progress value={progress} className="h-1" />
                  </div>
                )}

                {hasImportProgress && !isRunning && (
                  <div className="text-muted-foreground mt-3 pl-2 text-xs">
                    已导入 {batch.imported_patents.toLocaleString()} /{' '}
                    {batch.total_patents.toLocaleString()} 条专利
                  </div>
                )}

                {batch.status === 'completed' && (
                  <div className="text-muted-foreground mt-3 flex items-center gap-4 pl-2 text-xs">
                    <span>{batch.total_files} 个文件</span>
                    <span>{batch.imported_patents} 条专利</span>
                  </div>
                )}

                {batch.status === 'failed' && batch.error_message && (
                  <p className="text-destructive mt-2 line-clamp-1 pl-2 text-xs">
                    {batch.error_message}
                  </p>
                )}
              </div>
            </Link>
          )
        })}
      </CardContent>
    </Card>
  )
}
