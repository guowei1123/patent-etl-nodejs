'use client'

import useSWR from 'swr'
import { AppShell } from '@/components/layout/app-shell'
import { Header } from '@/components/layout/header'
import { StatsCards } from '@/components/dashboard/stats-cards'
import { BatchList } from '@/components/batches/batch-list'
import { NewBatchDialog } from '@/components/batches/new-batch-dialog'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { AlertCircle, Database, Settings } from 'lucide-react'
import Link from 'next/link'
import type { DashboardStats, SyncBatch, PaginatedResponse } from '@/types'

const fetcher = (url: string) => fetch(url).then((res) => res.json())
const hasRunningBatch = (batches: SyncBatch[]) =>
  batches.some((b) =>
    ['downloading', 'processing', 'importing'].includes(b.status),
  )

export default function DashboardPage() {
  const {
    data: statsData,
    error: statsError,
    mutate: mutateStats,
  } = useSWR<{
    success: boolean
    data: DashboardStats & {
      database_connected: boolean
      ftp_configured: boolean
    }
    error?: string
  }>('/api/stats', fetcher, {
    refreshInterval: 5000,
  })

  const { data: batchesData, mutate: mutateBatches } = useSWR<{
    success: boolean
    data: PaginatedResponse<SyncBatch>
  }>('/api/batches?limit=5', fetcher, {
    refreshInterval: (latestData) =>
      hasRunningBatch(latestData?.data?.items ?? []) ? 3000 : 0,
  })

  const handleRefresh = () => {
    mutateStats()
    mutateBatches()
  }

  const stats = statsData?.data
  const batches = batchesData?.data?.items || []
  const isLoading = !statsData && !statsError
  const showSetupWarning =
    stats && (!stats.database_connected || !stats.ftp_configured)

  return (
    <AppShell>
      <Header
        title="仪表盘"
        description="专利数据湖仓一体化平台概览"
        onRefresh={handleRefresh}
        action={<NewBatchDialog onSuccess={handleRefresh} />}
      />

      <div className="space-y-6 p-6">
        {/* Setup Warning */}
        {showSetupWarning && (
          <Card className="border-warning/50 bg-warning/5">
            <CardContent className="flex items-center gap-4 py-4">
              <div className="bg-warning/20 flex h-10 w-10 items-center justify-center rounded-lg">
                <AlertCircle className="text-warning h-5 w-5" />
              </div>
              <div className="flex-1">
                <p className="text-foreground text-sm font-medium">
                  系统配置不完整
                </p>
                <p className="text-muted-foreground text-xs">
                  {!stats.database_connected && '数据库未连接。'}
                  {!stats.ftp_configured && 'FTP 服务器未配置。'}
                  请前往设置页面完成配置。
                </p>
              </div>
              <Link href="/settings">
                <Button variant="outline" size="sm">
                  <Settings className="mr-2 h-4 w-4" />
                  前往设置
                </Button>
              </Link>
            </CardContent>
          </Card>
        )}

        {/* Stats Cards */}
        {isLoading ? (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {[...Array(4)].map((_, i) => (
              <Card key={i} className="bg-card border-border">
                <CardContent className="p-6">
                  <div className="bg-secondary h-24 animate-pulse rounded" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : stats ? (
          <StatsCards stats={stats} />
        ) : (
          <Card className="border-destructive/50">
            <CardContent className="flex items-center gap-4 py-6">
              <Database className="text-destructive h-8 w-8" />
              <div>
                <p className="text-foreground font-medium">无法加载统计数据</p>
                <p className="text-muted-foreground text-sm">
                  {statsData?.error || '请检查数据库连接'}
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Recent Batches */}
        <div className="grid gap-6 lg:grid-cols-2">
          <BatchList batches={batches} />

          {/* Quick Actions */}
          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="text-base font-medium">快速操作</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Link href="/batches" className="block">
                <div className="border-border hover:bg-secondary/50 flex items-center gap-4 rounded-lg border p-4 transition-colors">
                  <div className="bg-secondary flex h-10 w-10 items-center justify-center rounded-lg">
                    <Database className="text-muted-foreground h-5 w-5" />
                  </div>
                  <div className="flex-1">
                    <p className="text-foreground text-sm font-medium">
                      批次管理
                    </p>
                    <p className="text-muted-foreground text-xs">
                      查看和管理所有同步批次
                    </p>
                  </div>
                </div>
              </Link>

              <Link href="/patents" className="block">
                <div className="border-border hover:bg-secondary/50 flex items-center gap-4 rounded-lg border p-4 transition-colors">
                  <div className="bg-secondary flex h-10 w-10 items-center justify-center rounded-lg">
                    <Database className="text-muted-foreground h-5 w-5" />
                  </div>
                  <div className="flex-1">
                    <p className="text-foreground text-sm font-medium">
                      专利数据
                    </p>
                    <p className="text-muted-foreground text-xs">
                      浏览和搜索专利数据库
                    </p>
                  </div>
                </div>
              </Link>

              <Link href="/settings" className="block">
                <div className="border-border hover:bg-secondary/50 flex items-center gap-4 rounded-lg border p-4 transition-colors">
                  <div className="bg-secondary flex h-10 w-10 items-center justify-center rounded-lg">
                    <Settings className="text-muted-foreground h-5 w-5" />
                  </div>
                  <div className="flex-1">
                    <p className="text-foreground text-sm font-medium">
                      系统设置
                    </p>
                    <p className="text-muted-foreground text-xs">
                      配置 FTP 和数据库连接
                    </p>
                  </div>
                </div>
              </Link>
            </CardContent>
          </Card>
        </div>
      </div>
    </AppShell>
  )
}
