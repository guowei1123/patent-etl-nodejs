'use client'

import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Layers,
  FileText,
  Lightbulb,
  Wrench,
  Clock,
  AlertCircle,
} from 'lucide-react'
import type { DashboardStats } from '@/types'
import { cn } from '@/lib/utils'

interface StatsCardsProps {
  stats: DashboardStats & {
    database_connected: boolean
    ftp_configured: boolean
  }
}

export function StatsCards({ stats }: StatsCardsProps) {
  const cards = [
    {
      title: '总批次数',
      value: stats.total_batches,
      icon: Layers,
      description: `${stats.pending_batches} 个待处理`,
      trend: stats.pending_batches > 0 ? 'warning' : 'neutral',
      accent: 'bg-warning',
    },
    {
      title: '总专利数',
      value: stats.total_patents.toLocaleString(),
      icon: FileText,
      description: `本周新增 ${stats.this_week_patents}`,
      trend: 'success',
      accent: 'bg-success',
    },
    {
      title: '发明授权',
      value: stats.invention_patents.toLocaleString(),
      icon: Lightbulb,
      description: '发明专利数量',
      trend: 'neutral',
      accent: 'bg-primary',
    },
    {
      title: '实用新型',
      value: stats.utility_model_patents.toLocaleString(),
      icon: Wrench,
      description: '实用新型专利数量',
      trend: 'neutral',
      accent: 'bg-info',
    },
  ]

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      {cards.map((card) => (
        <Card
          key={card.title}
          className="border-border/80 bg-card/92 overflow-hidden shadow-xs"
        >
          <CardContent className="p-0">
            <div className={cn('h-1', card.accent)} />
            <div className="p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-muted-foreground text-xs font-medium tracking-wide">
                    {card.title}
                  </p>
                  <p className="text-foreground mt-2 text-3xl font-semibold tracking-tight">
                    {card.value}
                  </p>
                </div>
                <div className="bg-secondary/75 flex size-10 items-center justify-center rounded-lg border">
                  <card.icon
                    className="text-muted-foreground size-5"
                    aria-hidden="true"
                  />
                </div>
              </div>
              <div className="mt-4 flex items-center justify-between gap-2">
                <p className="text-muted-foreground truncate text-xs">
                  {card.description}
                </p>
                {card.trend === 'warning' && stats.pending_batches > 0 && (
                  <Badge variant="secondary" className="bg-warning/18">
                    待处理
                  </Badge>
                )}
                {card.trend === 'success' && stats.this_week_patents > 0 && (
                  <Badge variant="secondary" className="bg-success/18">
                    有新增
                  </Badge>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      ))}

      {/* Connection Status Cards */}
      <Card
        className={cn(
          'bg-card/92 border-border/80 col-span-full overflow-hidden shadow-xs md:col-span-2',
          !stats.database_connected && 'border-destructive/50',
        )}
      >
        <CardHeader className="border-border/70 border-b pb-4">
          <CardTitle className="text-base font-medium">同步控制面</CardTitle>
          <CardDescription>
            数据库连接、FTP 配置和最近同步记录
          </CardDescription>
        </CardHeader>
        <CardContent className="p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
            <div className="flex items-center gap-3">
              <div
                className={cn(
                  'flex size-11 items-center justify-center rounded-lg border',
                  stats.database_connected
                    ? 'border-success/25 bg-success/16'
                    : 'border-destructive/25 bg-destructive/16',
                )}
              >
                <Clock
                  className={cn(
                    'size-5',
                    stats.database_connected
                      ? 'text-success'
                      : 'text-destructive',
                  )}
                  aria-hidden="true"
                />
              </div>
              <div className="min-w-0">
                <p className="text-foreground text-sm font-medium">最近同步</p>
                <p className="text-muted-foreground text-xs">
                  {stats.last_sync_at
                    ? new Date(stats.last_sync_at).toLocaleString('zh-CN')
                    : '暂无同步记录'}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3 lg:ml-auto">
              <div className="bg-secondary/55 flex items-center gap-2 rounded-md border px-3 py-2">
                <span
                  className={cn(
                    'flex size-2 rounded-full',
                    stats.database_connected ? 'bg-success' : 'bg-destructive',
                  )}
                />
                <span className="text-muted-foreground text-xs font-medium">
                  数据库 {stats.database_connected ? '已连接' : '未连接'}
                </span>
              </div>
              <div className="bg-secondary/55 flex items-center gap-2 rounded-md border px-3 py-2">
                <span
                  className={cn(
                    'flex size-2 rounded-full',
                    stats.ftp_configured ? 'bg-success' : 'bg-warning',
                  )}
                />
                <span className="text-muted-foreground text-xs font-medium">
                  FTP {stats.ftp_configured ? '已配置' : '未配置'}
                </span>
              </div>
            </div>
          </div>

          {stats.failed_batches > 0 && (
            <div className="bg-destructive/10 mt-4 flex items-center gap-2 rounded-lg px-3 py-2">
              <AlertCircle
                className="text-destructive size-4"
                aria-hidden="true"
              />
              <span className="text-destructive text-sm">
                {stats.failed_batches} 个批次同步失败
              </span>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
