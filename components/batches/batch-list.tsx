'use client'

import Link from 'next/link'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import {
  ChevronRight,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
  Download,
  FileArchive,
  FileSearch,
  Database,
} from 'lucide-react'
import type { SyncBatch, BatchStatus } from '@/types'
import { cn } from '@/lib/utils'

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
  extracting: {
    label: '解压中',
    icon: FileArchive,
    variant: 'default',
    color: 'text-info',
  },
  parsing: {
    label: '解析中',
    icon: FileSearch,
    variant: 'default',
    color: 'text-info',
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
  utility_model: '实用新型',
}

function getProgress(batch: SyncBatch): number {
  if (batch.status === 'completed') return 100
  if (batch.status === 'pending') return 0
  if (batch.status === 'failed') return 0

  const stages = ['downloading', 'extracting', 'parsing', 'importing']
  const stageIndex = stages.indexOf(batch.status)
  const baseProgress = stageIndex * 25

  if (batch.total_files > 0 || batch.total_patents > 0) {
    const stageProgress =
      batch.status === 'importing' && batch.total_patents > 0
        ? (batch.imported_patents / batch.total_patents) * 25
        : batch.total_files > 0
          ? (batch.processed_files / batch.total_files) * 25
          : 0
    return Math.min(baseProgress + stageProgress, 99)
  }

  return baseProgress
}

export function BatchList({ batches, showAll = false }: BatchListProps) {
  const displayBatches = showAll ? batches : batches.slice(0, 5)

  if (batches.length === 0) {
    return (
      <Card className="bg-card border-border">
        <CardContent className="flex flex-col items-center justify-center py-12">
          <div className="bg-secondary flex h-12 w-12 items-center justify-center rounded-full">
            <Clock className="text-muted-foreground h-6 w-6" />
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
    <Card className="bg-card border-border">
      <CardHeader className="flex flex-row items-center justify-between pb-4">
        <CardTitle className="text-base font-medium">最近批次</CardTitle>
        {!showAll && batches.length > 5 && (
          <Link href="/batches">
            <Button variant="ghost" size="sm" className="text-muted-foreground">
              查看全部
              <ChevronRight className="ml-1 h-4 w-4" />
            </Button>
          </Link>
        )}
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        {displayBatches.map((batch) => {
          const status = statusConfig[batch.status]
          const StatusIcon = status.icon
          const progress = getProgress(batch)
          const isRunning = [
            'downloading',
            'extracting',
            'parsing',
            'importing',
          ].includes(batch.status)

          return (
            <Link
              key={batch.batch_code}
              href={`/batches/${batch.batch_code}`}
              className="block"
            >
              <div className="group border-border bg-secondary/30 hover:bg-secondary/50 rounded-lg border p-4 transition-colors">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div
                      className={cn(
                        'flex h-8 w-8 items-center justify-center rounded-lg',
                        batch.status === 'completed'
                          ? 'bg-success/20'
                          : batch.status === 'failed'
                            ? 'bg-destructive/20'
                            : isRunning
                              ? 'bg-info/20'
                              : 'bg-secondary',
                      )}
                    >
                      {isRunning ? (
                        <Loader2
                          className={cn('h-4 w-4 animate-spin', status.color)}
                        />
                      ) : (
                        <StatusIcon className={cn('h-4 w-4', status.color)} />
                      )}
                    </div>
                    <div>
                      <p className="text-foreground text-sm font-medium">
                        {batch.batch_code}
                      </p>
                      <p className="text-muted-foreground text-xs">
                        {dataTypeLabels[batch.data_type]} ·{' '}
                        {new Date(batch.created_at).toLocaleDateString('zh-CN')}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <Badge variant={status.variant} className="text-xs">
                      {status.label}
                    </Badge>
                    <ChevronRight className="text-muted-foreground h-4 w-4 opacity-0 transition-opacity group-hover:opacity-100" />
                  </div>
                </div>

                {isRunning && (
                  <div className="mt-3">
                    <div className="text-muted-foreground mb-1 flex items-center justify-between text-xs">
                      <span>进度</span>
                      <span>{Math.round(progress)}%</span>
                    </div>
                    <Progress value={progress} className="h-1" />
                  </div>
                )}

                {batch.status === 'completed' && (
                  <div className="text-muted-foreground mt-3 flex items-center gap-4 text-xs">
                    <span>{batch.total_files} 个文件</span>
                    <span>{batch.imported_patents} 条专利</span>
                  </div>
                )}

                {batch.status === 'failed' && batch.error_message && (
                  <p className="text-destructive mt-2 line-clamp-1 text-xs">
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
