'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { AppShell } from '@/components/layout/app-shell'
import { Header } from '@/components/layout/header'
import { PatentTable } from '@/components/patents/patent-table'
import type { PatentListItem, PaginatedResponse } from '@/types'

type RequestError = Error & {
  status?: number
}

const fetcher = async (url: string) => {
  const res = await fetch(url)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    const error = new Error(
      body.error || `请求失败 (${res.status})`,
    ) as RequestError
    error.status = res.status
    throw error
  }
  return res.json()
}

export default function PatentsPage() {
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [expression, setExpression] = useState('')
  const [typeFilter, setTypeFilter] = useState<'all' | 'B' | 'U'>('all')

  const params = new URLSearchParams()
  params.set('page', String(page))
  params.set('limit', '20')
  if (search) params.set('search', search)
  if (expression) params.set('expression', expression)
  if (typeFilter !== 'all') params.set('kind', typeFilter)

  const { data, error, mutate, isLoading, isValidating } = useSWR<{
    success: boolean
    data: PaginatedResponse<PatentListItem>
  }>(`/api/patents?${params.toString()}`, fetcher, {
    keepPreviousData: true,
  })
  const expressionErrorMessage =
    error?.status === 400 ? error.message : undefined

  const patents = data?.data || {
    items: [],
    total: 0,
    page: 1,
    limit: 20,
    total_pages: 0,
  }

  const handleSearch = (newSearch: string) => {
    setSearch(newSearch)
    setExpression('')
    setPage(1)
  }

  const handleExpressionSearch = (newExpression: string) => {
    setSearch('')
    setExpression(newExpression)
    setPage(1)
  }

  const handleTypeFilter = (type: 'all' | 'B' | 'U') => {
    setTypeFilter(type)
    setPage(1)
  }

  return (
    <AppShell>
      <Header
        title="专利数据"
        description="浏览和搜索已同步的专利数据"
        onRefresh={() => mutate()}
      />

      <div className="p-6">
        <PatentTable
          data={patents}
          onPageChange={setPage}
          onSearch={handleSearch}
          onExpressionSearch={handleExpressionSearch}
          onTypeFilter={handleTypeFilter}
          search={search}
          expression={expression}
          typeFilter={typeFilter}
          isLoading={isLoading || isValidating}
          hasError={Boolean(error)}
          errorMessage={error?.message}
          expressionErrorMessage={expressionErrorMessage}
        />
      </div>
    </AppShell>
  )
}
