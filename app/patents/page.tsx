'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { AppShell } from '@/components/layout/app-shell'
import { Header } from '@/components/layout/header'
import { PatentTable } from '@/components/patents/patent-table'
import { Card, CardContent } from '@/components/ui/card'
import type { Patent, PaginatedResponse } from '@/types'

const fetcher = (url: string) => fetch(url).then((res) => res.json())

export default function PatentsPage() {
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<'all' | 'B' | 'U'>('all')

  const params = new URLSearchParams()
  params.set('page', String(page))
  params.set('limit', '50')
  if (search) params.set('search', search)
  if (typeFilter !== 'all') params.set('kind', typeFilter)

  const { data, error, mutate } = useSWR<{
    success: boolean
    data: PaginatedResponse<Patent>
  }>(`/api/patents?${params.toString()}`, fetcher)

  const isLoading = !data && !error
  const patents = data?.data || {
    items: [],
    total: 0,
    page: 1,
    limit: 50,
    total_pages: 0,
  }

  const handleSearch = (newSearch: string) => {
    setSearch(newSearch)
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
        {isLoading ? (
          <Card className="bg-card border-border">
            <CardContent className="py-12">
              <div className="flex items-center justify-center">
                <div className="border-primary h-8 w-8 animate-spin rounded-full border-2 border-t-transparent" />
              </div>
            </CardContent>
          </Card>
        ) : (
          <PatentTable
            data={patents}
            onPageChange={setPage}
            onSearch={handleSearch}
            onTypeFilter={handleTypeFilter}
            search={search}
            typeFilter={typeFilter}
          />
        )}
      </div>
    </AppShell>
  )
}
