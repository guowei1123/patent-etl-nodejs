import { Suspense } from 'react'
import { AppShell } from '@/components/layout/app-shell'
import { Header } from '@/components/layout/header'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { ClassificationsClient } from './classifications-client'

function ClassificationsFallback() {
  return (
    <AppShell>
      <Header
        title="分类字典"
        description="查询 IPC/CPC 分类号、标题、层级与版本"
      />
      <div className="flex flex-col gap-6 p-6">
        <Card className="bg-card border-border">
          <CardHeader>
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-4 w-full max-w-md" />
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Skeleton className="h-9 w-full" />
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardContent className="flex flex-col gap-2 pt-6">
            {Array.from({ length: 8 }).map((_, index) => (
              <Skeleton key={index} className="h-12 w-full" />
            ))}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  )
}

export default function ClassificationsPage() {
  return (
    <Suspense fallback={<ClassificationsFallback />}>
      <ClassificationsClient />
    </Suspense>
  )
}
