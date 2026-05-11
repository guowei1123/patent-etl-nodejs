'use client'

import { use } from 'react'
import useSWR from 'swr'
import Link from 'next/link'
import { AppShell } from '@/components/layout/app-shell'
import { Header } from '@/components/layout/header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import {
  ArrowLeft,
  Lightbulb,
  Wrench,
  Calendar,
  User,
  Building,
  Tag,
  FileText,
  Loader2,
} from 'lucide-react'
import type { Patent } from '@/types'
import { cn } from '@/lib/utils'

const fetcher = (url: string) => fetch(url).then((res) => res.json())

function InfoItem({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Calendar
  label: string
  value: string | null | undefined
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="bg-secondary flex h-8 w-8 items-center justify-center rounded-lg">
        <Icon className="text-muted-foreground h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-muted-foreground text-xs">{label}</p>
        <p className="text-foreground mt-0.5 text-sm wrap-break-word">
          {value || '-'}
        </p>
      </div>
    </div>
  )
}

export default function PatentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = use(params)

  const { data, error } = useSWR<{
    success: boolean
    data: Patent
  }>(`/api/patents/${id}`, fetcher)

  const patent = data?.data
  const isLoading = !data && !error

  if (isLoading) {
    return (
      <AppShell>
        <div className="flex h-screen items-center justify-center">
          <Loader2 className="text-muted-foreground h-8 w-8 animate-spin" />
        </div>
      </AppShell>
    )
  }

  if (!patent) {
    return (
      <AppShell>
        <div className="flex h-screen flex-col items-center justify-center">
          <p className="text-muted-foreground">专利不存在</p>
          <Link
            href="/patents"
            className="text-accent mt-4 text-sm hover:underline"
          >
            返回列表
          </Link>
        </div>
      </AppShell>
    )
  }

  return (
    <AppShell>
      <Header title="专利详情" description={patent.patent_number} />

      <div className="space-y-6 p-6">
        {/* Back Link */}
        <Link
          href="/patents"
          className="text-muted-foreground hover:text-foreground inline-flex items-center text-sm"
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          返回专利列表
        </Link>

        {/* Title Card */}
        <Card className="bg-card border-border">
          <CardContent className="p-6">
            <div className="flex items-start gap-4">
              <div
                className={cn(
                  'flex h-12 w-12 items-center justify-center rounded-lg',
                  patent.patent_type === 'invention'
                    ? 'bg-info/20'
                    : 'bg-warning/20',
                )}
              >
                {patent.patent_type === 'invention' ? (
                  <Lightbulb className="text-info h-6 w-6" />
                ) : (
                  <Wrench className="text-warning h-6 w-6" />
                )}
              </div>
              <div className="flex-1">
                <div className="mb-2 flex items-center gap-2">
                  <Badge
                    variant="outline"
                    className={cn(
                      patent.patent_type === 'invention'
                        ? 'border-info/50 text-info'
                        : 'border-warning/50 text-warning',
                    )}
                  >
                    {patent.patent_type === 'invention'
                      ? '发明授权'
                      : '实用新型'}
                  </Badge>
                  <span className="text-muted-foreground font-mono text-sm">
                    {patent.patent_number}
                  </span>
                </div>
                <h1 className="text-foreground text-xl font-semibold text-balance">
                  {patent.title}
                </h1>
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-6 lg:grid-cols-3">
          {/* Basic Info */}
          <Card className="bg-card border-border lg:col-span-1">
            <CardHeader>
              <CardTitle className="text-base font-medium">基本信息</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <InfoItem icon={User} label="申请人" value={patent.applicant} />
              <InfoItem icon={User} label="发明人" value={patent.inventor} />
              <InfoItem
                icon={Building}
                label="代理机构"
                value={patent.agency}
              />
              <InfoItem icon={User} label="代理人" value={patent.agent} />

              <Separator className="my-4" />

              <InfoItem
                icon={FileText}
                label="申请号"
                value={patent.application_number}
              />
              <InfoItem
                icon={Calendar}
                label="申请日"
                value={
                  patent.application_date
                    ? new Date(patent.application_date).toLocaleDateString(
                        'zh-CN',
                      )
                    : undefined
                }
              />
              <InfoItem
                icon={FileText}
                label="公开号"
                value={patent.publication_number}
              />
              <InfoItem
                icon={Calendar}
                label="公开日"
                value={
                  patent.publication_date
                    ? new Date(patent.publication_date).toLocaleDateString(
                        'zh-CN',
                      )
                    : undefined
                }
              />
              <InfoItem
                icon={FileText}
                label="授权公告号"
                value={patent.grant_number}
              />
              <InfoItem
                icon={Calendar}
                label="授权公告日"
                value={
                  patent.grant_date
                    ? new Date(patent.grant_date).toLocaleDateString('zh-CN')
                    : undefined
                }
              />

              {patent.ipc_codes && patent.ipc_codes.length > 0 && (
                <>
                  <Separator className="my-4" />
                  <div className="space-y-2">
                    <div className="text-muted-foreground flex items-center gap-2">
                      <Tag className="h-4 w-4" />
                      <span className="text-xs">IPC 分类号</span>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {patent.ipc_codes.map((code, i) => (
                        <Badge
                          key={i}
                          variant="secondary"
                          className="font-mono text-xs"
                        >
                          {code}
                        </Badge>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {/* Content */}
          <Card className="bg-card border-border lg:col-span-2">
            <CardHeader>
              <CardTitle className="text-base font-medium">摘要</CardTitle>
            </CardHeader>
            <CardContent>
              {patent.abstract ? (
                <p className="text-muted-foreground text-sm leading-relaxed whitespace-pre-wrap">
                  {patent.abstract}
                </p>
              ) : (
                <p className="text-muted-foreground text-sm italic">
                  无摘要信息
                </p>
              )}
            </CardContent>
          </Card>

          {/* Claims */}
          {patent.claims && (
            <Card className="bg-card border-border lg:col-span-3">
              <CardHeader>
                <CardTitle className="text-base font-medium">
                  权利要求
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground max-h-[400px] overflow-y-auto text-sm leading-relaxed whitespace-pre-wrap">
                  {patent.claims}
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </AppShell>
  )
}
