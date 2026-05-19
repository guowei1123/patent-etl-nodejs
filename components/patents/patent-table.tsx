'use client'

import { useState, type FormEventHandler } from 'react'
import Link from 'next/link'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  ChevronLeft,
  ChevronRight,
  Search,
  ExternalLink,
  Lightbulb,
  RotateCcw,
  Wrench,
} from 'lucide-react'
import type { PatentListItem, PaginatedResponse } from '@/types'
import { cn } from '@/lib/utils'

interface PatentTableProps {
  data: PaginatedResponse<PatentListItem>
  onPageChange: (page: number) => void
  onSearch: (search: string) => void
  onTypeFilter: (type: 'all' | 'B' | 'U') => void
  search: string
  typeFilter: 'all' | 'B' | 'U'
  isLoading?: boolean
  hasError?: boolean
  errorMessage?: string
}

const SKELETON_ROW_COUNT = 8

function formatApplicants(patent: PatentListItem): string {
  if (!patent.applicants?.length) return '-'
  return patent.applicants.map((a) => a.name).join('; ')
}

export function PatentTable({
  data,
  onPageChange,
  onSearch,
  onTypeFilter,
  search,
  typeFilter,
  isLoading = false,
  hasError = false,
  errorMessage,
}: PatentTableProps) {
  const [searchInput, setSearchInput] = useState(search)

  const handleSearch: FormEventHandler<HTMLFormElement> = (e) => {
    e.preventDefault()
    onSearch(searchInput.trim())
  }

  const handleReset = () => {
    setSearchInput('')
    onSearch('')
    onTypeFilter('all')
  }

  const hasActiveFilters = search.length > 0 || typeFilter !== 'all'
  const hasData = data.total > 0
  const rangeStart = hasData ? (data.page - 1) * data.limit + 1 : 0
  const rangeEnd = hasData ? rangeStart + data.items.length - 1 : 0
  const isFirstPage = data.page <= 1
  const isLastPage = data.page >= data.total_pages
  const showSkeletonRows = isLoading
  const showEmptyState = !showSkeletonRows && data.items.length === 0
  const paginationDisabled = isLoading || hasError

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="bg-card border-border space-y-4 rounded-lg border p-4">
        {hasError && !isLoading ? (
          <div className="border-destructive/30 bg-destructive/5 rounded-md border px-3 py-2 text-sm">
            <p className="text-foreground">
              数据更新失败，当前显示的是上一次成功加载的结果。
            </p>
            {errorMessage ? (
              <p className="text-muted-foreground mt-1 text-xs">
                {errorMessage}
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <form
            onSubmit={handleSearch}
            className="flex w-full flex-col gap-2 sm:flex-row xl:max-w-2xl"
          >
            <div className="relative flex-1">
              <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
              <Input
                placeholder="搜索公开号、名称、申请人..."
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                className="pl-9"
                disabled={isLoading}
              />
            </div>
            <div className="flex gap-2">
              <Button
                type="submit"
                variant="secondary"
                className="flex-1 sm:flex-none"
                disabled={isLoading}
              >
                搜索
              </Button>
              {hasActiveFilters ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleReset}
                  className="flex-1 sm:flex-none"
                  disabled={isLoading}
                >
                  <RotateCcw className="mr-2 h-4 w-4" />
                  重置
                </Button>
              ) : null}
            </div>
          </form>

          <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center sm:justify-end xl:w-auto">
            <Select
              value={typeFilter}
              onValueChange={(value) =>
                onTypeFilter(value as 'all' | 'B' | 'U')
              }
              disabled={isLoading}
            >
              <SelectTrigger className="w-full sm:w-[180px]">
                <SelectValue placeholder="专利类型" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部类型</SelectItem>
                <SelectItem value="B">发明授权</SelectItem>
                <SelectItem value="U">实用新型</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="border-border flex flex-col gap-3 border-t pt-4 md:flex-row md:items-center md:justify-between">
          <div className="space-y-1">
            {isLoading ? (
              <>
                <Skeleton className="h-5 w-28" />
                <Skeleton className="h-4 w-56" />
              </>
            ) : (
              <>
                <p className="text-sm font-medium">
                  共 {data.total.toLocaleString()} 条记录
                </p>
                <p className="text-muted-foreground text-sm">
                  {hasData
                    ? `当前显示第 ${rangeStart}-${rangeEnd} 条，第 ${data.page} / ${data.total_pages} 页`
                    : '当前没有匹配的专利数据'}
                </p>
              </>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {isLoading ? (
              <>
                <Skeleton className="h-7 w-24" />
                <Skeleton className="h-7 w-28" />
              </>
            ) : search ? (
              <Badge variant="secondary" className="px-2 py-1">
                关键词: {search}
              </Badge>
            ) : null}
            {typeFilter !== 'all' ? (
              <Badge variant="outline" className="px-2 py-1">
                类型: {typeFilter === 'B' ? '发明授权' : '实用新型'}
              </Badge>
            ) : null}
          </div>

          <div className="flex items-center gap-2 self-start md:self-auto">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onPageChange(data.page - 1)}
              disabled={paginationDisabled || isFirstPage}
            >
              <ChevronLeft className="mr-1 h-4 w-4" />
              上一页
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onPageChange(data.page + 1)}
              disabled={
                paginationDisabled || isLastPage || data.total_pages === 0
              }
            >
              下一页
              <ChevronRight className="ml-1 h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="border-border rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-[140px]">公开号</TableHead>
              <TableHead className="w-[100px]">类型</TableHead>
              <TableHead>名称</TableHead>
              <TableHead className="w-[150px]">申请人</TableHead>
              <TableHead className="w-[100px]">公开日期</TableHead>
              <TableHead className="w-[60px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {showSkeletonRows ? (
              Array.from({ length: SKELETON_ROW_COUNT }).map((_, index) => (
                <TableRow key={`skeleton-${index}`}>
                  <TableCell>
                    <Skeleton className="h-4 w-24" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-6 w-16 rounded-full" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-full max-w-[280px]" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-full max-w-[140px]" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-20" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-8 w-8" />
                  </TableCell>
                </TableRow>
              ))
            ) : showEmptyState ? (
              <TableRow>
                <TableCell colSpan={6} className="h-32 text-center">
                  <p className="text-muted-foreground">
                    {hasError
                      ? errorMessage || '数据加载失败，请稍后重试'
                      : '暂无数据'}
                  </p>
                </TableCell>
              </TableRow>
            ) : (
              data.items.map((patent) => (
                <TableRow key={patent.id} className="group">
                  <TableCell className="font-mono text-xs">
                    {patent.doc_number}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={cn(
                        'gap-1 text-xs',
                        patent.kind === 'B'
                          ? 'border-info/50 text-info'
                          : 'border-warning/50 text-warning',
                      )}
                    >
                      {patent.kind === 'B' ? (
                        <Lightbulb className="h-3 w-3" />
                      ) : (
                        <Wrench className="h-3 w-3" />
                      )}
                      {patent.kind === 'B' ? '发明' : '实用'}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-[300px]">
                    <p className="truncate text-sm" title={patent.title}>
                      {patent.title}
                    </p>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    <p
                      className="max-w-[150px] truncate"
                      title={formatApplicants(patent)}
                    >
                      {formatApplicants(patent)}
                    </p>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {patent.pub_date
                      ? new Date(patent.pub_date).toLocaleDateString('zh-CN')
                      : '-'}
                  </TableCell>
                  <TableCell>
                    <Link href={`/patents/${patent.id}`}>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 opacity-0 group-hover:opacity-100"
                      >
                        <ExternalLink className="h-4 w-4" />
                      </Button>
                    </Link>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
