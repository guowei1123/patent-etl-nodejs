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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
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
  Copy,
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
  onExpressionSearch: (expression: string) => void
  onTypeFilter: (type: 'all' | 'B' | 'U') => void
  search: string
  expression: string
  typeFilter: 'all' | 'B' | 'U'
  isLoading?: boolean
  hasError?: boolean
  errorMessage?: string
  expressionErrorMessage?: string
}

const SKELETON_ROW_COUNT = 8

type FormulaOutputFormat = 'format1' | 'format2'

function parseListInput(value: string): string[] {
  return value
    .split(/[\n,，、;；]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function formatApplicants(patent: PatentListItem): string {
  if (!patent.applicants?.length) return '-'
  return patent.applicants.map((a) => a.name).join('; ')
}

export function PatentTable({
  data,
  onPageChange,
  onSearch,
  onExpressionSearch,
  onTypeFilter,
  search,
  expression,
  typeFilter,
  isLoading = false,
  hasError = false,
  errorMessage,
  expressionErrorMessage,
}: PatentTableProps) {
  const [searchInput, setSearchInput] = useState(search)
  const [expressionInput, setExpressionInput] = useState(expression)
  const [isFormulaDialogOpen, setIsFormulaDialogOpen] = useState(false)
  const [generatedFormulaInput, setGeneratedFormulaInput] = useState('')
  const [formulaKeywordsInput, setFormulaKeywordsInput] = useState('')
  const [formulaIpcInput, setFormulaIpcInput] = useState('')
  const [formulaOutputFormat, setFormulaOutputFormat] =
    useState<FormulaOutputFormat>('format1')
  const [isGeneratingFormula, setIsGeneratingFormula] = useState(false)
  const [formulaGenerationError, setFormulaGenerationError] = useState<
    string | null
  >(null)

  const handleSearch: FormEventHandler<HTMLFormElement> = (e) => {
    e.preventDefault()
    setExpressionInput('')
    onExpressionSearch('')
    onSearch(searchInput.trim())
  }

  const handleExpressionSearch: FormEventHandler<HTMLFormElement> = (e) => {
    e.preventDefault()
    setSearchInput('')
    onSearch('')
    onExpressionSearch(expressionInput.trim())
  }

  const handleGenerateFormula = async () => {
    const keywords = parseListInput(formulaKeywordsInput)
    const ipcCodes = parseListInput(formulaIpcInput)

    if (keywords.length === 0) {
      setFormulaGenerationError('请至少输入一个关键词')
      return
    }

    if (ipcCodes.length === 0) {
      setFormulaGenerationError('请至少输入一个 IPC/CPC 分类号')
      return
    }

    setIsGeneratingFormula(true)
    setFormulaGenerationError(null)

    try {
      const response = await fetch('/api/search-formula-generation', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          keywords,
          ipcCodes,
          outputFormat: formulaOutputFormat,
        }),
      })
      const result = await response.json().catch(() => ({}))

      if (!response.ok || typeof result.formula !== 'string') {
        throw new Error(result.error || '检索式生成失败')
      }

      const nextExpression = result.formula.trim()
      setGeneratedFormulaInput(nextExpression)
    } catch (error) {
      setFormulaGenerationError(
        error instanceof Error ? error.message : '检索式生成失败',
      )
    } finally {
      setIsGeneratingFormula(false)
    }
  }

  const handleCopyFormula = async () => {
    if (!generatedFormulaInput.trim()) return
    await navigator.clipboard.writeText(generatedFormulaInput.trim())
  }

  const handleUseFormula = () => {
    const nextExpression = generatedFormulaInput.trim()
    if (!nextExpression) return

    setExpressionInput(nextExpression)
    setSearchInput('')
    setIsFormulaDialogOpen(false)
  }

  const handleReset = () => {
    setSearchInput('')
    setExpressionInput('')
    onSearch('')
    onExpressionSearch('')
    onTypeFilter('all')
  }

  const hasActiveFilters =
    search.length > 0 || expression.length > 0 || typeFilter !== 'all'
  const hasData = data.total > 0
  const rangeStart = hasData ? (data.page - 1) * data.limit + 1 : 0
  const rangeEnd = hasData ? rangeStart + data.items.length - 1 : 0
  const isFirstPage = data.page <= 1
  const isLastPage = data.page >= data.total_pages
  const showSkeletonRows = isLoading
  const showEmptyState = !showSkeletonRows && data.items.length === 0
  const hasDataError = hasError && !expressionErrorMessage
  const paginationDisabled = isLoading || hasDataError

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="bg-card border-border space-y-4 rounded-lg border p-4">
        {hasDataError && !isLoading ? (
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

        <form onSubmit={handleExpressionSearch} className="flex flex-col gap-2">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Dialog
              open={isFormulaDialogOpen}
              onOpenChange={setIsFormulaDialogOpen}
            >
              <Button
                type="button"
                variant="secondary"
                className="shrink-0"
                disabled={isLoading}
                onClick={() => setIsFormulaDialogOpen(true)}
              >
                生成
              </Button>
              <DialogContent className="sm:max-w-2xl">
                <DialogHeader>
                  <DialogTitle>生成专利检索式</DialogTitle>
                  <DialogDescription>
                    输入关键词和 IPC/CPC 分类号，生成后会填入主检索框。
                  </DialogDescription>
                </DialogHeader>

                <div className="grid gap-4">
                  <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_180px]">
                    <div className="space-y-1.5">
                      <Label htmlFor="formula-keywords">关键词</Label>
                      <Input
                        id="formula-keywords"
                        placeholder="蓝牙、扭矩扳手"
                        value={formulaKeywordsInput}
                        onChange={(e) =>
                          setFormulaKeywordsInput(e.target.value)
                        }
                        disabled={isGeneratingFormula}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="formula-format">生成格式</Label>
                      <Select
                        value={formulaOutputFormat}
                        onValueChange={(value) =>
                          setFormulaOutputFormat(value as FormulaOutputFormat)
                        }
                        disabled={isGeneratingFormula}
                      >
                        <SelectTrigger id="formula-format" className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="format1">
                            关键词 + IPC/CPC
                          </SelectItem>
                          <SelectItem value="format2">仅关键词</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="formula-ipc">IPC/CPC 分类号</Label>
                    <Input
                      id="formula-ipc"
                      placeholder="B, F, G, H"
                      value={formulaIpcInput}
                      onChange={(e) => setFormulaIpcInput(e.target.value)}
                      disabled={isGeneratingFormula}
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="formula-result">生成结果</Label>
                    <Textarea
                      id="formula-result"
                      placeholder="生成的检索式会显示在这里，可手动编辑"
                      value={generatedFormulaInput}
                      onChange={(e) => setGeneratedFormulaInput(e.target.value)}
                      className="min-h-28 resize-y font-mono text-sm"
                      disabled={isGeneratingFormula}
                    />
                  </div>

                  {formulaGenerationError ? (
                    <p className="text-destructive text-sm">
                      {formulaGenerationError}
                    </p>
                  ) : null}
                </div>

                <DialogFooter className="sm:justify-between">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={handleGenerateFormula}
                    disabled={isGeneratingFormula}
                  >
                    {isGeneratingFormula ? '生成中...' : '生成检索式'}
                  </Button>
                  <div className="flex flex-col-reverse gap-2 sm:flex-row">
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={handleCopyFormula}
                      disabled={
                        !generatedFormulaInput.trim() || isGeneratingFormula
                      }
                    >
                      <Copy className="mr-2 h-4 w-4" />
                      复制
                    </Button>
                    <Button
                      type="button"
                      onClick={handleUseFormula}
                      disabled={
                        !generatedFormulaInput.trim() || isGeneratingFormula
                      }
                    >
                      使用
                    </Button>
                  </div>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <Input
              id="patent-expression"
              aria-describedby="patent-expression-help patent-expression-error"
              aria-invalid={Boolean(expressionErrorMessage)}
              title={
                expressionErrorMessage ||
                '字段: TI 标题, TIAB 标题摘要, PA 申请人, PN 公开号, AN 申请号, IPC/CPC 分类号, AB 摘要, CL 权利要求, 公开日'
              }
              placeholder="TIAB=(新能源 AND 电池) AND IPC=(H01M OR G06F)"
              value={expressionInput}
              onChange={(e) => setExpressionInput(e.target.value)}
              className={cn(
                'min-w-0 flex-1 font-mono text-sm',
                expressionErrorMessage
                  ? 'border-destructive focus-visible:ring-destructive/20'
                  : '',
              )}
              disabled={isLoading}
            />

            <p id="patent-expression-help" className="sr-only">
              字段: TI 标题, TIAB 标题摘要, PA 申请人, PN 公开号, AN 申请号,
              IPC/CPC 分类号, AB 摘要, CL 权利要求, 公开日; 支持
              AND/OR/NOT、括号和引号短语。
            </p>
            {expressionErrorMessage ? (
              <p id="patent-expression-error" className="sr-only">
                {expressionErrorMessage}
              </p>
            ) : null}

            <Button
              type="submit"
              variant="outline"
              className="shrink-0"
              disabled={isLoading}
            >
              <Search className="mr-2 h-4 w-4" />
              检索
            </Button>
          </div>
        </form>

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
            {expression ? (
              <Badge variant="secondary" className="max-w-full px-2 py-1">
                <span className="truncate">检索式: {expression}</span>
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
                    {hasDataError
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
