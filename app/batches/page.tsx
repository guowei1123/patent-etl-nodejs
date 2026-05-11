'use client'

import useSWR from 'swr'
import { Sidebar } from '@/components/layout/sidebar'
import { Header } from '@/components/layout/header'
import { BatchList } from '@/components/batches/batch-list'
import { NewBatchDialog } from '@/components/batches/new-batch-dialog'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useState } from 'react'
import type { SyncBatch, PaginatedResponse, BatchStatus } from '@/types'

const fetcher = (url: string) => fetch(url).then((res) => res.json())

export default function BatchesPage() {
  const [statusFilter, setStatusFilter] = useState<BatchStatus | 'all'>('all')
  const [page, setPage] = useState(1)

  const url =
    statusFilter === 'all'
      ? `/api/batches?page=${page}&limit=20`
      : `/api/batches?page=${page}&limit=20&status=${statusFilter}`

  const { data, error, mutate } = useSWR<{
    success: boolean
    data: PaginatedResponse<SyncBatch>
  }>(url, fetcher, { refreshInterval: 5000 })

  const handleRefresh = () => {
    mutate()
  }

  const batches = data?.data?.items || []
  const pagination = data?.data
  const isLoading = !data && !error

  return (
    <div className="flex min-h-screen">
      <Sidebar />

      <main className="flex-1 pl-64">
        <Header
          title="批次管理"
          description="管理数据同步批次"
          onRefresh={handleRefresh}
          action={<NewBatchDialog onSuccess={handleRefresh} />}
        />

        <div className="space-y-6 p-6">
          {/* Filters */}
          <div className="flex items-center justify-between">
            <Tabs
              value={statusFilter}
              onValueChange={(v) => {
                setStatusFilter(v as BatchStatus | 'all')
                setPage(1)
              }}
            >
              <TabsList className="bg-secondary">
                <TabsTrigger value="all">全部</TabsTrigger>
                <TabsTrigger value="pending">待处理</TabsTrigger>
                <TabsTrigger value="downloading">进行中</TabsTrigger>
                <TabsTrigger value="completed">已完成</TabsTrigger>
                <TabsTrigger value="failed">失败</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>

          {/* Batch List */}
          {isLoading ? (
            <Card className="bg-card border-border">
              <CardContent className="py-12">
                <div className="flex items-center justify-center">
                  <div className="border-primary h-8 w-8 animate-spin rounded-full border-2 border-t-transparent" />
                </div>
              </CardContent>
            </Card>
          ) : (
            <BatchList batches={batches} showAll />
          )}

          {/* Pagination */}
          {pagination && pagination.total_pages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-muted-foreground text-sm">
                共 {pagination.total} 个批次，第 {pagination.page} /{' '}
                {pagination.total_pages} 页
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                >
                  上一页
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => p + 1)}
                  disabled={page >= pagination.total_pages}
                >
                  下一页
                </Button>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
