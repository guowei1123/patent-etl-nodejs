'use client'

import { FormEventHandler, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import useSWR from 'swr'
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
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
import {
  ToggleGroup,
  ToggleGroupItem,
} from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'
import type {
  ClassificationRow,
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
  data: PaginatedResponse<ClassificationRow>
}

type ClassificationTreeApiResponse = {
  success: boolean
  data: ClassificationTreeResponse
}

type ClassificationView = 'tree' | 'list'

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

function getTitleStatus(row: ClassificationRow) {
  if (!row.title_zh) return '未补齐'
  return row.title_zh_source || '已补齐'
}

function ClassificationTable({
  rows,
  isLoading,
}: {
  rows: ClassificationRow[]
  isLoading: boolean
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
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-36">分类号</TableHead>
          <TableHead className="min-w-96">英文标题</TableHead>
          <TableHead className="min-w-48">中文标题</TableHead>
          <TableHead className="w-20">层级</TableHead>
          <TableHead className="w-24">版本</TableHead>
          <TableHead className="min-w-52">来源文件</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={`${row.version}-${row.code_norm}`}>
            <TableCell className="font-mono text-sm">
              <div className="flex flex-col gap-1">
                <span translate="no">{row.code}</span>
                <span translate="no" className="text-muted-foreground text-xs">
                  {row.code_norm}
                </span>
              </div>
            </TableCell>
            <TableCell className="max-w-xl whitespace-normal">
              <p className="line-clamp-3 break-words">{row.title_en}</p>
            </TableCell>
            <TableCell className="whitespace-normal">
              {row.title_zh ? (
                <div className="flex flex-col gap-1">
                  <span className="break-words">{row.title_zh}</span>
                  {row.title_zh_source ? (
                    <Badge variant="outline">{row.title_zh_source}</Badge>
                  ) : null}
                </div>
              ) : (
                <span className="text-muted-foreground">未补齐</span>
              )}
            </TableCell>
            <TableCell>
              <Badge variant="secondary">{formatLevel(row)}</Badge>
            </TableCell>
            <TableCell className="font-mono text-sm">{row.version}</TableCell>
            <TableCell className="max-w-64 truncate font-mono text-xs">
              {row.source_file || '未记录'}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function ClassificationTreeNodeRow({
  node,
  type,
  query,
  isSearch,
}: {
  node: ClassificationTreeNode
  type: ClassificationType
  query: string
  isSearch: boolean
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

  return (
    <>
      <div
        className={cn(
          'grid min-w-[760px] grid-cols-[minmax(18rem,1.1fr)_minmax(20rem,1.4fr)_minmax(12rem,0.8fr)_7rem_7rem] items-start gap-3 border-b px-3 py-2 text-sm',
          node.is_match && 'bg-muted/50',
        )}
      >
        <div
          className="flex min-w-0 items-start gap-1"
          style={{ paddingLeft: `${node.depth * 1.25}rem` }}
        >
          {canExpand ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              aria-label={isExpanded ? `折叠 ${node.code}` : `展开 ${node.code}`}
              aria-expanded={isExpanded}
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
        <div className="min-w-0">
          <p className="line-clamp-2 break-words">{node.title_en}</p>
        </div>
        <div className="min-w-0">
          {node.title_zh ? (
            <p className="line-clamp-2 break-words">{node.title_zh}</p>
          ) : (
            <span className="text-muted-foreground">未补齐</span>
          )}
        </div>
        <div>
          <Badge variant="outline">{formatLevel(node)}</Badge>
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="font-mono text-xs" translate="no">
            {node.version}
          </span>
          <span className="text-muted-foreground truncate text-xs">
            {getTitleStatus(node)}
          </span>
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
        <div className="flex min-w-[760px] flex-col gap-2 border-b px-3 py-2">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : null}

      {isExpanded
        ? children.map((child) => (
            <ClassificationTreeNodeRow
              key={`${query}-${child.version}-${child.code_norm}`}
              node={child}
              type={type}
              query={query}
              isSearch={false}
            />
          ))
        : null}
    </>
  )
}

function ClassificationTree({
  type,
  query,
  rows,
  isSearch,
  isLoading,
}: {
  type: ClassificationType
  query: string
  rows: ClassificationTreeNode[]
  isSearch: boolean
  isLoading: boolean
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
    <div className="overflow-x-auto rounded-lg border">
      <div className="grid min-w-[760px] grid-cols-[minmax(18rem,1.1fr)_minmax(20rem,1.4fr)_minmax(12rem,0.8fr)_7rem_7rem] gap-3 border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">
        <div>分类号</div>
        <div>英文标题</div>
        <div>中文标题</div>
        <div>层级</div>
        <div>版本 / 状态</div>
      </div>
      <div aria-live="polite">
        {rows.map((node) => (
          <ClassificationTreeNodeRow
            key={`${query}-${node.version}-${node.code_norm}`}
            node={node}
            type={type}
            query={query}
            isSearch={isSearch}
          />
        ))}
      </div>
    </div>
  )
}

function ClassificationEmpty({
  hasQuery,
  onReset,
}: {
  hasQuery: boolean
  onReset: () => void
}) {
  return (
    <Empty className="min-h-80">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <BookOpen aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>
          {hasQuery ? '未找到匹配分类号' : '请先导入 IPC/CPC 字典'}
        </EmptyTitle>
        <EmptyDescription>
          {hasQuery
            ? '请检查分类号格式或重置查询后重新检索。'
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
  isBusy,
  hasQuery,
  onSearch,
  onReset,
}: {
  initialQuery: string
  isBusy: boolean
  hasQuery: boolean
  onSearch: (query: string) => void
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
      <FieldGroup className="min-w-0 flex-1">
        <Field>
          <FieldLabel htmlFor="classification-query">分类号或标题</FieldLabel>
          <InputGroup>
            <InputGroupAddon>
              <Search aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              id="classification-query"
              value={queryInput}
              onChange={(event) => setQueryInput(event.target.value)}
              placeholder="输入分类号或标题关键词"
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
  const type = getClassificationType(searchParams.get('type'))
  const view = getClassificationView(searchParams.get('view'))
  const page = getPositiveInt(searchParams.get('page'), 1)
  const query = searchParams.get('q') || ''

  const listApiUrl = useMemo(() => {
    const params = new URLSearchParams()
    params.set('type', type)
    params.set('page', String(page))
    params.set('limit', '20')
    if (query) params.set('q', query)
    return `/api/classifications?${params.toString()}`
  }, [page, query, type])
  const treeApiUrl = useMemo(() => {
    const params = new URLSearchParams()
    params.set('view', 'tree')
    params.set('type', type)
    params.set('limit', query ? '100' : '50')
    if (query) params.set('q', query)
    return `/api/classifications?${params.toString()}`
  }, [query, type])

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
  const hasQuery = Boolean(query.trim())
  const activeError = view === 'tree' ? treeError : listError
  const isTreeBusy = isTreeLoading || isTreeValidating
  const isListBusy = isListLoading || isListValidating
  const isBusy = view === 'tree' ? isTreeBusy : isListBusy

  const updateParams = (next: {
    type?: ClassificationType
    q?: string
    page?: number
    view?: ClassificationView
  }) => {
    const params = new URLSearchParams(searchParams.toString())
    params.set('type', next.type || type)
    params.set('view', next.view || view)
    params.set('page', String(next.page || 1))

    const nextQuery = next.q ?? query
    if (nextQuery.trim()) params.set('q', nextQuery.trim())
    else params.delete('q')

    router.push(`${pathname}?${params.toString()}`)
  }

  const handleReset = () => {
    updateParams({ q: '', page: 1 })
  }

  return (
    <AppShell>
      <Header
        title="分类字典"
        description="查询 IPC/CPC 分类号、标题、层级与版本"
        onRefresh={() => {
          if (view === 'tree') void mutateTree()
          else void mutateList()
        }}
        isRefreshing={view === 'tree' ? isTreeValidating : isListValidating}
      />

      <div className="flex flex-col gap-6 p-6">
        <Card className="bg-card border-border">
          <CardHeader className="gap-3">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div className="flex min-w-0 flex-col gap-1">
                <CardTitle className="text-base">字典查询</CardTitle>
                <CardDescription>
                  支持 H01M、H01B 1/00、H04L0065101600、Y02A20/108
                  或英文标题关键词。
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
              key={`${type}-${query}`}
              initialQuery={query}
              isBusy={isBusy}
              hasQuery={hasQuery}
              onSearch={(nextQuery) => updateParams({ q: nextQuery, page: 1 })}
              onReset={handleReset}
            />
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardHeader className="gap-2">
            <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
              <div>
                <CardTitle className="text-base">
                  {type.toUpperCase()} 查询结果
                </CardTitle>
                <CardDescription>
                  {view === 'tree'
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
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <ToggleGroup
                  type="single"
                  value={view}
                  onValueChange={(value) => {
                    if (value === 'tree' || value === 'list') {
                      updateParams({ view: value, page: 1 })
                    }
                  }}
                  aria-label="切换分类字典视图"
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
                <Badge variant="outline">{hasQuery ? query : '全部字典'}</Badge>
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
            ((view === 'tree' && treeResult.items.length === 0) ||
              (view === 'list' && result.items.length === 0)) &&
            !isBusy ? (
              <ClassificationEmpty hasQuery={hasQuery} onReset={handleReset} />
            ) : view === 'tree' ? (
              <ClassificationTree
                type={type}
                query={query}
                rows={treeResult.items}
                isSearch={treeResult.is_search}
                isLoading={isTreeBusy}
              />
            ) : (
              <ClassificationTable rows={result.items} isLoading={isListBusy} />
            )}

            {view === 'tree' && !hasQuery && treeResult.total > treeResult.limit ? (
              <Alert>
                <AlertDescription>
                  当前层仅显示前 {treeResult.limit.toLocaleString('zh-CN')}{' '}
                  条，请输入分类号或标题关键词缩小范围。
                </AlertDescription>
              </Alert>
            ) : null}

            {view === 'list' && result.total_pages > 1 ? (
              <div className="flex flex-col gap-3 border-t pt-4 md:flex-row md:items-center md:justify-between">
                <p className="text-muted-foreground text-sm">
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
    </AppShell>
  )
}
