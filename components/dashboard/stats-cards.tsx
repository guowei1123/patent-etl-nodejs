'use client'

import { Card, CardContent } from '@/components/ui/card'
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
    },
    {
      title: '总专利数',
      value: stats.total_patents.toLocaleString(),
      icon: FileText,
      description: `本周新增 ${stats.this_week_patents}`,
      trend: 'success',
    },
    {
      title: '发明授权',
      value: stats.invention_patents.toLocaleString(),
      icon: Lightbulb,
      description: '发明专利数量',
      trend: 'neutral',
    },
    {
      title: '实用新型',
      value: stats.utility_model_patents.toLocaleString(),
      icon: Wrench,
      description: '实用新型专利数量',
      trend: 'neutral',
    },
  ]

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      {cards.map((card) => (
        <Card key={card.title} className="bg-card border-border">
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div className="bg-secondary flex h-10 w-10 items-center justify-center rounded-lg">
                <card.icon className="text-muted-foreground h-5 w-5" />
              </div>
              {card.trend === 'warning' && stats.pending_batches > 0 && (
                <span className="bg-warning flex h-2 w-2 rounded-full" />
              )}
              {card.trend === 'success' && stats.this_week_patents > 0 && (
                <span className="bg-success flex h-2 w-2 rounded-full" />
              )}
            </div>
            <div className="mt-4">
              <p className="text-foreground text-2xl font-bold">{card.value}</p>
              <p className="text-muted-foreground text-sm">{card.title}</p>
            </div>
            <p className="text-muted-foreground mt-2 text-xs">
              {card.description}
            </p>
          </CardContent>
        </Card>
      ))}

      {/* Connection Status Cards */}
      <Card
        className={cn(
          'bg-card border-border col-span-full md:col-span-2',
          !stats.database_connected && 'border-destructive/50',
        )}
      >
        <CardContent className="p-6">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-3">
              <div
                className={cn(
                  'flex h-10 w-10 items-center justify-center rounded-lg',
                  stats.database_connected
                    ? 'bg-success/20'
                    : 'bg-destructive/20',
                )}
              >
                <Clock
                  className={cn(
                    'h-5 w-5',
                    stats.database_connected
                      ? 'text-success'
                      : 'text-destructive',
                  )}
                />
              </div>
              <div>
                <p className="text-foreground text-sm font-medium">最近同步</p>
                <p className="text-muted-foreground text-xs">
                  {stats.last_sync_at
                    ? new Date(stats.last_sync_at).toLocaleString('zh-CN')
                    : '暂无同步记录'}
                </p>
              </div>
            </div>

            <div className="ml-auto flex items-center gap-6">
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    'flex h-2 w-2 rounded-full',
                    stats.database_connected ? 'bg-success' : 'bg-destructive',
                  )}
                />
                <span className="text-muted-foreground text-xs">
                  数据库 {stats.database_connected ? '已连接' : '未连接'}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    'flex h-2 w-2 rounded-full',
                    stats.ftp_configured ? 'bg-success' : 'bg-warning',
                  )}
                />
                <span className="text-muted-foreground text-xs">
                  FTP {stats.ftp_configured ? '已配置' : '未配置'}
                </span>
              </div>
            </div>
          </div>

          {stats.failed_batches > 0 && (
            <div className="bg-destructive/10 mt-4 flex items-center gap-2 rounded-lg px-3 py-2">
              <AlertCircle className="text-destructive h-4 w-4" />
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
