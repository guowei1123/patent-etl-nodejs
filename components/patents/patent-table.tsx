'use client'

import { useState } from 'react'
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
  Wrench,
} from 'lucide-react'
import type { Patent, PaginatedResponse, PatentType } from '@/types'
import { cn } from '@/lib/utils'

interface PatentTableProps {
  data: PaginatedResponse<Patent>
  onPageChange: (page: number) => void
  onSearch: (search: string) => void
  onTypeFilter: (type: PatentType | 'all') => void
  search: string
  typeFilter: PatentType | 'all'
}

export function PatentTable({
  data,
  onPageChange,
  onSearch,
  onTypeFilter,
  search,
  typeFilter,
}: PatentTableProps) {
  const [searchInput, setSearchInput] = useState(search)

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    onSearch(searchInput)
  }

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <form onSubmit={handleSearch} className="flex max-w-md flex-1 gap-2">
          <div className="relative flex-1">
            <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
            <Input
              placeholder="搜索专利号、名称、申请人..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="pl-9"
            />
          </div>
          <Button type="submit" variant="secondary">
            搜索
          </Button>
        </form>

        <Select
          value={typeFilter}
          onValueChange={(value) => onTypeFilter(value as PatentType | 'all')}
        >
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder="专利类型" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部类型</SelectItem>
            <SelectItem value="invention">发明授权</SelectItem>
            <SelectItem value="utility_model">实用新型</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <div className="border-border rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-[140px]">专利号</TableHead>
              <TableHead className="w-[100px]">类型</TableHead>
              <TableHead>名称</TableHead>
              <TableHead className="w-[150px]">申请人</TableHead>
              <TableHead className="w-[100px]">授权日期</TableHead>
              <TableHead className="w-[60px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="h-32 text-center">
                  <p className="text-muted-foreground">暂无数据</p>
                </TableCell>
              </TableRow>
            ) : (
              data.items.map((patent) => (
                <TableRow key={patent.id} className="group">
                  <TableCell className="font-mono text-xs">
                    {patent.patent_number}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={cn(
                        'gap-1 text-xs',
                        patent.patent_type === 'invention'
                          ? 'border-info/50 text-info'
                          : 'border-warning/50 text-warning',
                      )}
                    >
                      {patent.patent_type === 'invention' ? (
                        <Lightbulb className="h-3 w-3" />
                      ) : (
                        <Wrench className="h-3 w-3" />
                      )}
                      {patent.patent_type === 'invention' ? '发明' : '实用'}
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
                      title={patent.applicant || ''}
                    >
                      {patent.applicant || '-'}
                    </p>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {patent.grant_date
                      ? new Date(patent.grant_date).toLocaleDateString('zh-CN')
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

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-sm">
          共 {data.total.toLocaleString()} 条，第 {data.page} /{' '}
          {data.total_pages} 页
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => onPageChange(data.page - 1)}
            disabled={data.page <= 1}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => onPageChange(data.page + 1)}
            disabled={data.page >= data.total_pages}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}
