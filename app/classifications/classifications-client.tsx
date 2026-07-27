'use client'

import { FormEventHandler, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import useSWR from 'swr'
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  Eye,
  ListTree,
  RotateCcw,
  Search,
  TableProperties,
} from 'lucide-react'
import { AppShell } from '@/components/layout/app-shell'
import { Header } from '@/components/layout/header'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group'
import { Separator } from '@/components/ui/separator'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'
import type {
  ClassificationRow,
  ClassificationSearchMode,
  ClassificationSemanticRow,
  ClassificationTreeNode,
  ClassificationTreeResponse,
  ClassificationType,
  PaginatedResponse,
} from '@/types'

type RequestError = Error & {
  status?: number
}

type ClassificationResponse = {
  success: boolean
  data: PaginatedResponse<ClassificationSearchRow>
}

type ClassificationTreeApiResponse = {
  success: boolean
  data: ClassificationTreeResponse
}

type ClassificationView = 'tree' | 'list'

type ClassificationSearchRow = ClassificationRow | ClassificationSemanticRow

type ClassificationDetail = ClassificationSearchRow | ClassificationTreeNode

const fetcher = async <T,>(url: string): Promise<T> => {
  const response = await fetch(url)
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(
      body.error || `请求失败 (${response.status})`,
    ) as RequestError
    error.status = response.status
    throw error
  }
  return body
}

function getClassificationType(value: string | null): ClassificationType {
  return value === 'cpc' ? 'cpc' : 'ipc'
}

function getPositiveInt(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function formatLevel(row: ClassificationRow): string {
  if (row.level !== null) return String(row.level)
  if (row.subgroup) return '组'
  if (row.subclass) return '小类'
  if (row.class_code) return '大类'
  return '部'
}

function getClassificationView(value: string | null): ClassificationView {
  return value === 'list' ? 'list' : 'tree'
}

function getClassificationSearchMode(
  value: string | null,
): ClassificationSearchMode {
  return value === 'semantic' ? 'semantic' : 'keyword'
}

function getTitleStatus(row: ClassificationRow) {
  if (!row.title_zh) return '未补齐'
  return row.title_zh_source || '已补齐'
}

function getPrimaryTitle(row: ClassificationRow): string {
  return row.title_zh?.trim() || row.title_en
}

function hasTreeFields(
  row: ClassificationDetail,
): row is ClassificationTreeNode {
  return 'depth' in row
}

function hasSemanticFields(
  row: ClassificationDetail,
): row is ClassificationSemanticRow {
  return 'similarity_percent' in row
}

function DetailField({
  label,
  value,
  isCode = false,
}: {
  label: string
  value: string | number | boolean | null | undefined
  isCode?: boolean
}) {
  const displayValue =
    typeof value === 'boolean'
      ? value
        ? '是'
        : '否'
      : value === null || value === undefined || value === ''
        ? '未记录'
        : value

  return (
    <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-3 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          'min-w-0 break-words',
          isCode && 'font-mono text-sm',
        )}
        translate={isCode ? 'no' : undefined}
      >
        {displayValue}
      </dd>
    </div>
  )
}

function ClassificationDetailSheet({
  row,
  open,
  onOpenChange,
}: {
  row: ClassificationDetail | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>分类详情</SheetTitle>
          <SheetDescription>
            查看该 IPC/CPC 条目的标题、层级、版本、来源和结构字段。
          </SheetDescription>
        </SheetHeader>

        {row ? (
          <div className="flex flex-col gap-5 px-4 pb-4">
            <div className="flex flex-col gap-2">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="font-mono text-base" translate="no">
                  {row.code}
                </span>
                <Badge variant="secondary">{formatLevel(row)}</Badge>
                <Badge variant="outline">{getTitleStatus(row)}</Badge>
              </div>
              <p
                className="text-muted-foreground break-words font-mono text-xs"
                translate="no"
              >
                {row.code_norm}
              </p>
            </div>

            <Separator />

            <section className="flex flex-col gap-3">
              <h3 className="text-sm font-medium">基础信息</h3>
              <dl className="flex flex-col gap-2">
                <DetailField label="分类号" value={row.code} isCode />
                <DetailField label="规范化 code" value={row.code_norm} isCode />
                <DetailField label="原始 code" value={row.source_code} isCode />
                <DetailField label="层级" value={formatLevel(row)} />
                <DetailField label="层级值" value={row.level} />
                <DetailField label="版本" value={row.version} isCode />
              </dl>
            </section>

            <Separator />

            <section className="flex flex-col gap-3">
              <h3 className="text-sm font-medium">标题</h3>
              <dl className="flex flex-col gap-2">
                <DetailField label="中文标题" value={row.title_zh} />
                <DetailField label="英文标题" value={row.title_en} />
                <DetailField
                  label="中文来源状态"
                  value={getTitleStatus(row)}
                />
              </dl>
            </section>

            <Separator />

            <section className="flex flex-col gap-3">
              <h3 className="text-sm font-medium">结构字段</h3>
              <dl className="flex flex-col gap-2">
                <DetailField label="section" value={row.section} isCode />
                <DetailField label="class" value={row.class_code} isCode />
                <DetailField label="subclass" value={row.subclass} isCode />
                <DetailField label="main_group" value={row.main_group} isCode />
                <DetailField label="subgroup" value={row.subgroup} isCode />
              </dl>
            </section>

            {hasTreeFields(row) ? (
              <>
                <Separator />
                <section className="flex flex-col gap-3">
                  <h3 className="text-sm font-medium">树节点</h3>
                  <dl className="flex flex-col gap-2">
                    <DetailField
                      label="父级 code"
                      value={row.parent_code_norm}
                      isCode
                    />
                    <DetailField label="深度" value={row.depth} />
                    <DetailField label="有子级" value={row.has_children} />
                    <DetailField label="命中查询" value={row.is_match} />
                  </dl>
                </section>
              </>
            ) : null}

            {hasSemanticFields(row) ? (
              <>
                <Separator />
                <section className="flex flex-col gap-3">
                  <h3 className="text-sm font-medium">语义匹配</h3>
                  <dl className="flex flex-col gap-2">
                    <DetailField
                      label="相似度"
                      value={row.similarity_percent}
                    />
                    <DetailField
                      label="向量模型"
                      value={row.embedding_model}
                      isCode
                    />
                    <DetailField
                      label="向量维度"
                      value={row.embedding_dimensions}
                    />
                    <DetailField
                      label="语料范围"
                      value={row.embedding_locale}
                      isCode
                    />
                  </dl>
                </section>
              </>
            ) : null}
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

function ClassificationTable({
  rows,
  isLoading,
  showSimilarity,
  onViewDetails,
}: {
  rows: ClassificationSearchRow[]
  isLoading: boolean
  showSimilarity: boolean
  onViewDetails: (row: ClassificationSearchRow) => void
}) {
  if (isLoading) {
    return (
      <div className="flex flex-col gap-2">
        {Array.from({ length: 8 }).map((_, index) => (
          <Skeleton key={index} className="h-12 w-full" />
        ))}
      </div>
    )
  }

  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table className="min-w-[880px]">
        <TableHeader>
          <TableRow>
            <TableHead className="w-36">分类号</TableHead>
            <TableHead className="min-w-96">标题</TableHead>
            <TableHead className="min-w-64">英文标题</TableHead>
            {showSimilarity ? (
              <TableHead className="w-24 text-right">相似度</TableHead>
            ) : null}
            <TableHead className="w-20">层级</TableHead>
            <TableHead className="w-24">版本</TableHead>
            <TableHead className="w-28 text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={`${row.version}-${row.code_norm}`}>
              <TableCell className="font-mono text-sm">
                <div className="flex flex-col gap-1">
                  <span translate="no">{row.code}</span>
                  <span
                    translate="no"
                    className="text-muted-foreground text-xs"
                  >
                    {row.code_norm}
                  </span>
                </div>
              </TableCell>
              <TableCell className="max-w-xl whitespace-normal">
                <div className="flex flex-col gap-1">
                  <p className="line-clamp-3 break-words">
                    {getPrimaryTitle(row)}
                  </p>
                  {row.title_zh && row.title_zh_source ? (
                    <Badge variant="outline">{row.title_zh_source}</Badge>
                  ) : null}
                  {!row.title_zh ? (
                    <span className="text-muted-foreground text-xs">
                      暂无中文标题，显示英文
                    </span>
                  ) : null}
                </div>
              </TableCell>
              <TableCell className="max-w-lg whitespace-normal">
                <p className="line-clamp-3 break-words">{row.title_en}</p>
              </TableCell>
              {showSimilarity ? (
                <TableCell className="text-right tabular-nums">
                  {hasSemanticFields(row) ? (
                    <Badge variant="secondary">
                      {row.similarity_percent}
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground">-</span>
                  )}
                </TableCell>
              ) : null}
              <TableCell>
                <Badge variant="secondary">{formatLevel(row)}</Badge>
              </TableCell>
              <TableCell className="font-mono text-sm">{row.version}</TableCell>
              <TableCell className="text-right">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onViewDetails(row)}
                >
                  <Eye data-icon="inline-start" aria-hidden="true" />
                  查看详情
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function ClassificationTreeNodeRow({
  node,
  type,
  query,
  isSearch,
  onViewDetails,
}: {
  node: ClassificationTreeNode
  type: ClassificationType
  query: string
  isSearch: boolean
  onViewDetails: (row: ClassificationTreeNode) => void
}) {
  const [isExpanded, setIsExpanded] = useState(false)
  const shouldLoadChildren = isExpanded && node.has_children && !isSearch
  const childUrl = shouldLoadChildren
    ? `/api/classifications?view=tree&type=${type}&parent=${encodeURIComponent(
        node.code_norm,
      )}&limit=100`
    : null
  const {
    data: childData,
    error: childError,
    isLoading: isLoadingChildren,
  } = useSWR<ClassificationTreeApiResponse>(childUrl, fetcher)
  const children = childData?.data.items || []
  const canExpand = node.has_children && !isSearch
  const rowId = `classification-row-${type}-${node.code_norm.replace(
    /[^a-zA-Z0-9_-]/g,
    '-',
  )}`
  const childrenId = `${rowId}-children`

  return (
    <>
      <div
        id={rowId}
        role="row"
        aria-level={node.depth + 1}
        aria-expanded={canExpand ? isExpanded : undefined}
        aria-owns={canExpand && isExpanded ? childrenId : undefined}
        className={cn(
          'grid min-w-[780px] grid-cols-[minmax(18rem,1.1fr)_minmax(20rem,1.4fr)_minmax(14rem,0.9fr)_7rem_7rem] items-start gap-3 border-b px-3 py-2 text-sm [contain-intrinsic-size:44px] [content-visibility:auto]',
          node.is_match && 'bg-muted/50',
        )}
      >
        <div
          role="gridcell"
          className="flex min-w-0 items-start gap-1"
          style={{ paddingLeft: `${node.depth * 1.25}rem` }}
        >
          {canExpand ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              aria-label={
                isExpanded ? `折叠 ${node.code}` : `展开 ${node.code}`
              }
              aria-expanded={isExpanded}
              aria-controls={childrenId}
              onClick={() => setIsExpanded((current) => !current)}
            >
              {isExpanded ? (
                <ChevronDown aria-hidden="true" />
              ) : (
                <ChevronRight aria-hidden="true" />
              )}
            </Button>
          ) : (
            <span className="size-7 shrink-0" aria-hidden="true" />
          )}
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="font-mono" translate="no">
                {node.code}
              </span>
              {node.is_match ? <Badge variant="secondary">命中</Badge> : null}
            </div>
            <span
              className="text-muted-foreground truncate font-mono text-xs"
              translate="no"
            >
              {node.code_norm}
            </span>
          </div>
        </div>
        <div role="gridcell" className="min-w-0">
          <p className="line-clamp-2 break-words">{getPrimaryTitle(node)}</p>
          {node.title_zh ? (
            <span className="text-muted-foreground text-xs">
              {getTitleStatus(node)}
            </span>
          ) : (
            <span className="text-muted-foreground text-xs">
              暂无中文标题，显示英文
            </span>
          )}
        </div>
        <div role="gridcell" className="min-w-0">
          <p className="line-clamp-2 break-words">{node.title_en}</p>
        </div>
        <div role="gridcell">
          <Badge variant="outline">{formatLevel(node)}</Badge>
        </div>
        <div role="gridcell" className="flex justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onViewDetails(node)}
          >
            <Eye data-icon="inline-start" aria-hidden="true" />
            查看详情
          </Button>
        </div>
      </div>

      {childError ? (
        <div className="border-b px-3 py-2">
          <Alert variant="destructive">
            <AlertDescription>
              子级加载失败，请检查数据库连接后重试。
            </AlertDescription>
          </Alert>
        </div>
      ) : null}

      {isLoadingChildren ? (
        <div className="flex min-w-[780px] flex-col gap-2 border-b px-3 py-2">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : null}

      {isExpanded ? (
        <div id={childrenId} role="presentation">
          {children.map((child) => (
            <ClassificationTreeNodeRow
              key={`${query}-${child.version}-${child.code_norm}`}
              node={child}
              type={type}
              query={query}
              isSearch={false}
              onViewDetails={onViewDetails}
            />
          ))}
        </div>
      ) : null}
    </>
  )
}

function ClassificationTree({
  type,
  query,
  rows,
  isSearch,
  isLoading,
  onViewDetails,
}: {
  type: ClassificationType
  query: string
  rows: ClassificationTreeNode[]
  isSearch: boolean
  isLoading: boolean
  onViewDetails: (row: ClassificationTreeNode) => void
}) {
  if (isLoading) {
    return (
      <div className="flex flex-col gap-2">
        {Array.from({ length: 10 }).map((_, index) => (
          <Skeleton key={index} className="h-11 w-full" />
        ))}
      </div>
    )
  }

  return (
    <div
      role="treegrid"
      aria-label="分类字典树"
      aria-rowcount={rows.length}
      className="overflow-x-auto rounded-lg border"
    >
      <div role="rowgroup">
        <div
          role="row"
          className="bg-muted/40 text-muted-foreground grid min-w-[780px] grid-cols-[minmax(18rem,1.1fr)_minmax(20rem,1.4fr)_minmax(14rem,0.9fr)_7rem_7rem] gap-3 border-b px-3 py-2 text-xs font-medium"
        >
          <div role="columnheader">分类号</div>
          <div role="columnheader">标题</div>
          <div role="columnheader">英文标题</div>
          <div role="columnheader">层级</div>
          <div role="columnheader" className="text-right">
            操作
          </div>
        </div>
      </div>
      <div role="rowgroup" aria-live="polite">
        {rows.map((node) => (
          <ClassificationTreeNodeRow
            key={`${query}-${node.version}-${node.code_norm}`}
            node={node}
            type={type}
            query={query}
            isSearch={isSearch}
            onViewDetails={onViewDetails}
          />
        ))}
      </div>
    </div>
  )
}

function ClassificationEmpty({
  hasQuery,
  searchMode,
  onReset,
}: {
  hasQuery: boolean
  searchMode: ClassificationSearchMode
  onReset: () => void
}) {
  const isSemantic = searchMode === 'semantic'

  return (
    <Empty className="min-h-80">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <BookOpen aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>
          {hasQuery
            ? isSemantic
              ? '未找到相近分类号'
              : '未找到匹配分类号'
            : isSemantic
              ? '请输入语义搜索内容'
              : '请先导入 IPC/CPC 字典'}
        </EmptyTitle>
        <EmptyDescription>
          {hasQuery
            ? isSemantic
              ? '请换用更具体的技术描述，或切回关键词搜索。'
              : '请检查分类号格式或重置查询后重新检索。'
            : isSemantic
              ? '输入技术描述或关键词后，将使用 IPC 向量数据召回相近分类号。'
              : '导入官方 IPC/CPC title list 后即可在这里查询分类字典。'}
        </EmptyDescription>
      </EmptyHeader>
      {hasQuery ? (
        <Button type="button" variant="outline" onClick={onReset}>
          <RotateCcw data-icon="inline-start" aria-hidden="true" />
          重置查询
        </Button>
      ) : null}
    </Empty>
  )
}

function ClassificationSearchForm({
  initialQuery,
  searchMode,
  canUseSemantic,
  isBusy,
  hasQuery,
  onSearch,
  onModeChange,
  onReset,
}: {
  initialQuery: string
  searchMode: ClassificationSearchMode
  canUseSemantic: boolean
  isBusy: boolean
  hasQuery: boolean
  onSearch: (query: string) => void
  onModeChange: (mode: ClassificationSearchMode) => void
  onReset: () => void
}) {
  const [queryInput, setQueryInput] = useState(initialQuery)

  const handleSearch: FormEventHandler<HTMLFormElement> = (event) => {
    event.preventDefault()
    onSearch(queryInput)
  }

  const handleReset = () => {
    setQueryInput('')
    onReset()
  }

  return (
    <form
      onSubmit={handleSearch}
      className="flex flex-col gap-3 md:flex-row md:items-end"
    >
      <FieldGroup className="md:w-52">
        <Field>
          <FieldLabel>搜索模式</FieldLabel>
          <ToggleGroup
            type="single"
            value={searchMode}
            onValueChange={(value) => {
              if (value === 'keyword' || value === 'semantic') {
                onModeChange(value)
              }
            }}
            aria-label="选择搜索模式"
            disabled={isBusy}
          >
            <ToggleGroupItem value="keyword" aria-label="关键词搜索">
              关键词
            </ToggleGroupItem>
            <ToggleGroupItem
              value="semantic"
              aria-label="语义搜索"
              disabled={!canUseSemantic}
            >
              语义
            </ToggleGroupItem>
          </ToggleGroup>
        </Field>
      </FieldGroup>
      <FieldGroup className="min-w-0 flex-1">
        <Field>
          <FieldLabel htmlFor="classification-query">
            {searchMode === 'semantic' ? '技术描述或关键词' : '分类号或标题'}
          </FieldLabel>
          <InputGroup>
            <InputGroupAddon>
              <Search aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              id="classification-query"
              name="classification-query"
              autoComplete="off"
              spellCheck={false}
              value={queryInput}
              onChange={(event) => setQueryInput(event.target.value)}
              placeholder={
                searchMode === 'semantic'
                  ? '输入锂电池隔膜、无线资源分配等技术描述…'
                  : '输入分类号或标题关键词…'
              }
              disabled={isBusy}
            />
            {queryInput ? (
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  type="button"
                  aria-label="清空查询"
                  onClick={() => setQueryInput('')}
                  disabled={isBusy}
                >
                  清空
                </InputGroupButton>
              </InputGroupAddon>
            ) : null}
          </InputGroup>
        </Field>
      </FieldGroup>
      <div className="flex gap-2 md:pb-0">
        <Button type="submit" disabled={isBusy}>
          <Search data-icon="inline-start" aria-hidden="true" />
          查询
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={handleReset}
          disabled={isBusy && !hasQuery}
        >
          <RotateCcw data-icon="inline-start" aria-hidden="true" />
          重置
        </Button>
      </div>
    </form>
  )
}

export function ClassificationsClient() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [selectedDetail, setSelectedDetail] =
    useState<ClassificationDetail | null>(null)
  const type = getClassificationType(searchParams.get('type'))
  const view = getClassificationView(searchParams.get('view'))
  const requestedSearchMode = getClassificationSearchMode(
    searchParams.get('mode'),
  )
  // /api/config 提供 embedding 是否配置；未配置时前端禁用语义搜索
  const { data: configData } = useSWR<{ embedding?: { configured?: boolean } }>(
    '/api/config',
    fetcher,
  )
  const embeddingConfigured = Boolean(configData?.embedding?.configured)
  const searchMode =
    type === 'cpc' || !embeddingConfigured ? 'keyword' : requestedSearchMode
  const effectiveView = searchMode === 'semantic' ? 'list' : view
  const page = getPositiveInt(searchParams.get('page'), 1)
  const query = searchParams.get('q') || ''
  const hasQuery = Boolean(query.trim())
  const canUseSemantic = type === 'ipc' && embeddingConfigured

  const listApiUrl = useMemo(() => {
    if (searchMode === 'semantic' && !query.trim()) return null

    const params = new URLSearchParams()
    params.set('type', type)
    params.set('page', searchMode === 'semantic' ? '1' : String(page))
    params.set('limit', '20')
    if (searchMode === 'semantic') params.set('mode', 'semantic')
    if (query) params.set('q', query)
    return `/api/classifications?${params.toString()}`
  }, [page, query, searchMode, type])
  const treeApiUrl = useMemo(() => {
    if (searchMode === 'semantic') return null

    const params = new URLSearchParams()
    params.set('view', 'tree')
    params.set('type', type)
    params.set('limit', query ? '100' : '50')
    if (query) params.set('q', query)
    return `/api/classifications?${params.toString()}`
  }, [query, searchMode, type])

  const {
    data: listData,
    error: listError,
    mutate: mutateList,
    isLoading: isListLoading,
    isValidating: isListValidating,
  } = useSWR<ClassificationResponse>(listApiUrl, fetcher, {
    keepPreviousData: true,
  })
  const {
    data: treeData,
    error: treeError,
    mutate: mutateTree,
    isLoading: isTreeLoading,
    isValidating: isTreeValidating,
  } = useSWR<ClassificationTreeApiResponse>(treeApiUrl, fetcher, {
    keepPreviousData: true,
  })
  const result = listData?.data || {
    items: [],
    total: 0,
    page,
    limit: 20,
    total_pages: 0,
  }
  const treeResult = treeData?.data || {
    items: [],
    total: 0,
    limit: query ? 100 : 50,
    parent_code_norm: null,
    is_search: Boolean(query),
  }
  const activeError = effectiveView === 'tree' ? treeError : listError
  const isTreeBusy = isTreeLoading || isTreeValidating
  const isListBusy = isListLoading || isListValidating
  const isBusy = effectiveView === 'tree' ? isTreeBusy : isListBusy

  const updateParams = (next: {
    type?: ClassificationType
    q?: string
    page?: number
    view?: ClassificationView
    mode?: ClassificationSearchMode
  }) => {
    const params = new URLSearchParams(searchParams.toString())
    const nextType = next.type || type
    const nextMode =
      nextType === 'cpc' ? 'keyword' : next.mode || searchMode
    const nextView =
      nextMode === 'semantic' ? 'list' : next.view || effectiveView

    params.set('type', nextType)
    params.set('view', nextView)
    params.set('page', String(nextMode === 'semantic' ? 1 : next.page || 1))

    if (nextMode === 'semantic') params.set('mode', 'semantic')
    else params.delete('mode')

    const nextQuery = next.q ?? query
    if (nextQuery.trim()) params.set('q', nextQuery.trim())
    else params.delete('q')

    router.push(`${pathname}?${params.toString()}`)
  }

  const handleReset = () => {
    updateParams({ q: '', page: 1 })
  }

  const handleViewDetails = (row: ClassificationDetail) => {
    setSelectedDetail(row)
  }

  return (
    <AppShell>
      <Header
        title="分类字典"
        description="查询 IPC/CPC 分类号、标题、层级与版本"
        onRefresh={() => {
          if (effectiveView === 'tree') void mutateTree()
          else void mutateList()
        }}
        isRefreshing={
          effectiveView === 'tree' ? isTreeValidating : isListValidating
        }
      />

      <div className="flex flex-col gap-6 p-6">
        <Card className="bg-card border-border">
          <CardHeader className="gap-3">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div className="flex min-w-0 flex-col gap-1">
                <CardTitle className="text-base">字典查询</CardTitle>
                <CardDescription>
                  {searchMode === 'semantic'
                    ? '输入技术描述后，使用已写入的 IPC 向量数据召回相近分类号。'
                    : '支持 H01M、H01B 1/00、H04L0065101600、Y02A20/108 或英文标题关键词。'}
                </CardDescription>
              </div>
              <Tabs
                value={type}
                onValueChange={(value) =>
                  updateParams({
                    type: value as ClassificationType,
                    page: 1,
                  })
                }
              >
                <TabsList>
                  <TabsTrigger value="ipc">IPC</TabsTrigger>
                  <TabsTrigger value="cpc">CPC</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
          </CardHeader>
          <CardContent>
            <ClassificationSearchForm
              key={`${type}-${searchMode}-${query}`}
              initialQuery={query}
              searchMode={searchMode}
              canUseSemantic={canUseSemantic}
              isBusy={isBusy}
              hasQuery={hasQuery}
              onSearch={(nextQuery) => updateParams({ q: nextQuery, page: 1 })}
              onModeChange={(mode) => updateParams({ mode, page: 1 })}
              onReset={handleReset}
            />
            {!canUseSemantic ? (
              <Alert className="mt-4">
                <AlertDescription>
                  {type === 'cpc'
                    ? 'CPC 暂未生成向量数据，当前仅支持关键词搜索。'
                    : '未配置 embedding 服务（OPENAI_EMBEDDING_MODEL），语义搜索已禁用。'}
                </AlertDescription>
              </Alert>
            ) : null}
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardHeader className="gap-2">
            <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
              <div>
                <CardTitle className="text-base">
                  {type.toUpperCase()}
                  {searchMode === 'semantic' ? ' 语义搜索结果' : ' 查询结果'}
                </CardTitle>
                <CardDescription>
                  {searchMode === 'semantic'
                    ? hasQuery
                      ? `返回 ${result.total.toLocaleString('zh-CN')} 条相近分类号`
                      : '输入技术描述后展示相近 IPC 分类号'
                    : effectiveView === 'tree'
                    ? treeResult.is_search
                      ? `展示 ${treeResult.total.toLocaleString('zh-CN')} 条命中及必要祖先链`
                      : `按需加载层级节点，当前层最多 ${treeResult.limit.toLocaleString(
                          'zh-CN',
                        )} 条`
                    : `共 ${result.total.toLocaleString('zh-CN')} 条记录，第 ${
                        result.total_pages ? result.page : 0
                      } / ${result.total_pages} 页`}
                </CardDescription>
              </div>
              <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
                <ToggleGroup
                  type="single"
                  value={effectiveView}
                  onValueChange={(value) => {
                    if (value === 'tree' || value === 'list') {
                      updateParams({ view: value, page: 1 })
                    }
                  }}
                  aria-label="切换分类字典视图"
                  disabled={searchMode === 'semantic'}
                >
                  <ToggleGroupItem value="tree" aria-label="树状视图">
                    <ListTree data-icon="inline-start" aria-hidden="true" />
                    树状视图
                  </ToggleGroupItem>
                  <ToggleGroupItem value="list" aria-label="列表视图">
                    <TableProperties
                      data-icon="inline-start"
                      aria-hidden="true"
                    />
                    列表视图
                  </ToggleGroupItem>
                </ToggleGroup>
                {searchMode === 'semantic' ? (
                  <Badge variant="secondary">语义结果以列表展示</Badge>
                ) : null}
                <Badge variant="outline" className="max-w-full">
                  <span
                    className="truncate"
                    translate={hasQuery ? 'no' : undefined}
                  >
                    {hasQuery ? query : '全部字典'}
                  </span>
                </Badge>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {activeError ? (
              <Alert variant="destructive">
                <AlertDescription>
                  {activeError.message ||
                    '分类字典查询失败，请检查数据库连接后重试'}
                </AlertDescription>
              </Alert>
            ) : null}

            {!activeError &&
            ((effectiveView === 'tree' && treeResult.items.length === 0) ||
              (effectiveView === 'list' && result.items.length === 0)) &&
            !isBusy ? (
              <ClassificationEmpty
                hasQuery={hasQuery}
                searchMode={searchMode}
                onReset={handleReset}
              />
            ) : effectiveView === 'tree' ? (
              <ClassificationTree
                type={type}
                query={query}
                rows={treeResult.items}
                isSearch={treeResult.is_search}
                isLoading={isTreeBusy}
                onViewDetails={handleViewDetails}
              />
            ) : (
              <ClassificationTable
                rows={result.items}
                isLoading={isListBusy}
                showSimilarity={searchMode === 'semantic'}
                onViewDetails={handleViewDetails}
              />
            )}

            {effectiveView === 'tree' &&
            !hasQuery &&
            treeResult.total > treeResult.limit ? (
              <Alert>
                <AlertDescription>
                  当前层仅显示前 {treeResult.limit.toLocaleString('zh-CN')}{' '}
                  条，请输入分类号或标题关键词缩小范围。
                </AlertDescription>
              </Alert>
            ) : null}

            {effectiveView === 'list' && result.total_pages > 1 ? (
              <div className="flex flex-col gap-3 border-t pt-4 md:flex-row md:items-center md:justify-between">
                <p className="text-muted-foreground text-sm tabular-nums">
                  每页 {result.limit} 条，第 {result.page} /{' '}
                  {result.total_pages} 页
                </p>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      updateParams({ page: Math.max(1, result.page - 1) })
                    }
                    disabled={isBusy || result.page <= 1}
                  >
                    上一页
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => updateParams({ page: result.page + 1 })}
                    disabled={isBusy || result.page >= result.total_pages}
                  >
                    下一页
                  </Button>
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <ClassificationDetailSheet
        row={selectedDetail}
        open={Boolean(selectedDetail)}
        onOpenChange={(open) => {
          if (!open) setSelectedDetail(null)
        }}
      />
    </AppShell>
  )
}
