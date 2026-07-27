'use client'

import { use } from 'react'
import useSWR from 'swr'
import Link from 'next/link'
import Image from 'next/image'
import { AppShell } from '@/components/layout/app-shell'
import { Header } from '@/components/layout/header'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { Spinner } from '@/components/ui/spinner'
import {
  ArrowLeft,
  Building,
  Calendar,
  FileText,
  Images,
  Lightbulb,
  Tag,
  User,
  Wrench,
} from 'lucide-react'
import type { Patent } from '@/types'
import { cn } from '@/lib/utils'

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

function DescriptionSection({
  id,
  title,
  content,
}: {
  id: string
  title: string
  content: string
}) {
  return (
    <section
      id={id}
      className="scroll-mt-28 flex flex-col gap-2 py-6 first:pt-0 last:pb-0"
    >
      <h3 className="text-foreground text-base font-medium">{title}</h3>
      <p className="text-muted-foreground text-sm leading-7 whitespace-pre-wrap">
        {content}
      </p>
    </section>
  )
}

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
      <div className="bg-secondary text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-lg">
        <Icon aria-hidden="true" className="text-muted-foreground size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-muted-foreground text-xs tracking-wide uppercase">
          {label}
        </p>
        <p className="text-foreground mt-1 text-sm wrap-break-word">
          {value || '-'}
        </p>
      </div>
    </div>
  )
}

function MetricCard({
  label,
  value,
}: {
  label: string
  value: string | null | undefined
}) {
  return (
    <div className="bg-secondary/40 rounded-xl border p-4">
      <p className="text-muted-foreground text-xs tracking-wide uppercase">
        {label}
      </p>
      <p className="text-foreground mt-2 text-sm font-medium wrap-break-word">
        {value || '-'}
      </p>
    </div>
  )
}

function NavChip({
  href,
  label,
  meta,
}: {
  href: string
  label: string
  meta?: string
}) {
  return (
    <a
      href={href}
      className="bg-secondary/50 hover:bg-secondary text-foreground inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors"
    >
      <span>{label}</span>
      {meta && <span className="text-muted-foreground text-xs">{meta}</span>}
    </a>
  )
}

function formatDate(d: Date | string | null | undefined): string | undefined {
  if (!d) return undefined
  const date = new Date(d)
  if (Number.isNaN(date.getTime())) return undefined
  return date.toLocaleDateString('zh-CN')
}

function joinText(
  items: Array<string | null | undefined> | null | undefined,
): string {
  if (!items?.length) return '-'

  const values = items
    .map((item) => item?.trim())
    .filter((item): item is string => Boolean(item))

  return values.length ? values.join('; ') : '-'
}

function joinNames(items: Array<{ name: string }> | null | undefined): string {
  return joinText(items?.map((a) => a.name))
}

function parseDrawingCaptions(
  drawingsDescription: string | undefined,
): Map<number, string> {
  const captions = new Map<number, string>()
  if (!drawingsDescription) return captions

  const text = drawingsDescription

  // 匹配模式：支持多种格式
  // 1. 图1是/为/：XXX
  // 2. 图1 XXX
  // 3. 图一/二/三... XXX
  const regex = /(?:图|Figure|Fig\.?)\s*(\d+|[一二三四五六七八九十百千]+)\s*(?:[:：是为]?\s*)([^；。\n\r]+)/gi
  let match
  while ((match = regex.exec(text)) !== null) {
    let numStr = match[1]
    let num: number

    // 转换中文数字
    if (/[一二三四五六七八九十百千]/.test(numStr)) {
      const cnMap: Record<string, number> = {
        '一': 1, '二': 2, '三': 3, '四': 4, '五': 5,
        '六': 6, '七': 7, '八': 8, '九': 9, '十': 10,
        '百': 100, '千': 1000
      }
      num = numStr.split('').reduce((acc, ch) => acc + (cnMap[ch] || 0), 0)
    } else {
      num = parseInt(numStr, 10)
    }

    const desc = match[2].trim().replace(/\s+/g, ' ')
    if (num > 0 && !captions.has(num) && desc.length > 0) {
      captions.set(num, desc)
    }
  }

  return captions
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
          <Spinner className="text-muted-foreground size-8" />
        </div>
      </AppShell>
    )
  }

  if (error) {
    return (
      <AppShell>
        <div className="flex h-screen items-center justify-center p-6">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FileText aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>
                {(error as RequestError).status === 404
                  ? '专利不存在'
                  : '数据加载失败'}
              </EmptyTitle>
              {(error as RequestError).status !== 404 ? (
                <EmptyDescription>{error.message}</EmptyDescription>
              ) : null}
            </EmptyHeader>
            <Button asChild variant="outline">
              <Link href="/patents">返回列表</Link>
            </Button>
          </Empty>
        </div>
      </AppShell>
    )
  }

  if (!patent) {
    return (
      <AppShell>
        <div className="flex h-screen items-center justify-center p-6">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FileText aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>专利不存在</EmptyTitle>
              <EmptyDescription>未找到匹配的专利记录。</EmptyDescription>
            </EmptyHeader>
            <Button asChild variant="outline">
              <Link href="/patents">返回列表</Link>
            </Button>
          </Empty>
        </div>
      </AppShell>
    )
  }

  const isInvention = patent.kind === 'B'
  const structuredClaims =
    patent.claims_structured?.filter((claim) => claim.claim_text?.trim()) ?? []
  const descriptionSections = patent.description
    ? [
        {
          id: 'description-technical-field',
          title: '技术领域',
          content: patent.description.technical_field,
        },
        {
          id: 'description-background-art',
          title: '背景技术',
          content: patent.description.background_art,
        },
        {
          id: 'description-disclosure',
          title: '发明内容',
          content: patent.description.disclosure,
        },
        {
          id: 'description-drawings-description',
          title: '附图说明',
          content: patent.description.drawings_description,
        },
        {
          id: 'description-embodiment',
          title: '具体实施方式',
          content: patent.description.embodiment,
        },
      ].filter(
        (
          section,
        ): section is {
          id: string
          title: string
          content: string
        } => Boolean(section.content),
      )
    : []
  const hasClaims = structuredClaims.length > 0 || Boolean(patent.claims)
  const hasDescription = descriptionSections.length > 0
  const hasCitations = Boolean(patent.citations?.length)
  const images = patent.images ?? []
  const abstractImage = images.find((image) => image.is_abstract)
  const bodyImages = images.filter((image) => !image.is_abstract)
  const drawingCaptions = parseDrawingCaptions(
    patent.description?.drawings_description,
  )
  const contentSections = [
    {
      id: 'section-abstract',
      label: '摘要',
      meta: patent.abstract ? '概览' : '无内容',
      visible: true,
    },
    {
      id: 'section-images',
      label: '附图',
      meta: bodyImages.length > 0 ? `${bodyImages.length} 张` : undefined,
      visible: bodyImages.length > 0,
    },
    {
      id: 'section-claims',
      label: '权利要求',
      meta: structuredClaims.length
        ? `${structuredClaims.length} 条`
        : patent.claims
          ? '全文'
          : undefined,
      visible: hasClaims,
    },
    {
      id: 'section-description',
      label: '说明书',
      meta: hasDescription ? `${descriptionSections.length} 节` : undefined,
      visible: hasDescription,
    },
    {
      id: 'section-citations',
      label: '引用文献',
      meta: hasCitations ? `${patent.citations.length} 条` : undefined,
      visible: hasCitations,
    },
  ].filter((section) => section.visible)
  const overviewMetrics = [
    {
      label: '申请人',
      value: patent.applicants?.length ? `${patent.applicants.length} 个` : '-',
    },
    {
      label: '发明人',
      value: patent.inventors?.length ? `${patent.inventors.length} 位` : '-',
    },
    {
      label: '权利要求',
      value: structuredClaims.length
        ? `${structuredClaims.length} 条`
        : patent.claims
          ? '已收录'
          : '-',
    },
    {
      label: '说明书章节',
      value: hasDescription ? `${descriptionSections.length} 节` : '-',
    },
    {
      label: '附图',
      value: bodyImages.length > 0 ? `${bodyImages.length} 张` : '-',
    },
  ]

  return (
    <AppShell>
      <Header title="专利详情" description={patent.doc_number} />

      <div className="p-6">
        <div id="top" className="mx-auto flex max-w-7xl flex-col gap-6">
          <Link
            href="/patents"
            className="text-muted-foreground hover:text-foreground inline-flex items-center text-sm"
          >
            <ArrowLeft aria-hidden="true" className="mr-2 size-4" />
            返回专利列表
          </Link>

          <Card className="bg-card border-border overflow-hidden">
            <CardContent className="p-6 lg:p-8">
              <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
                <div className="flex min-w-0 items-start gap-4">
                  <div
                    className={cn(
                      'flex size-14 shrink-0 items-center justify-center rounded-2xl',
                      isInvention ? 'bg-info/15' : 'bg-warning/20',
                    )}
                  >
                    {isInvention ? (
                      <Lightbulb aria-hidden="true" className="text-info size-7" />
                    ) : (
                      <Wrench
                        aria-hidden="true"
                        className="text-warning size-7"
                      />
                    )}
                  </div>
                  <div className="flex min-w-0 flex-col gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge
                        variant="outline"
                        className={cn(
                          isInvention
                            ? 'border-info/50 text-info'
                            : 'border-warning/50 text-warning',
                        )}
                      >
                        {isInvention ? '发明授权' : '实用新型'}
                      </Badge>
                      <Badge variant="secondary" className="font-mono">
                        {patent.doc_number}
                      </Badge>
                      {patent.grant_date && (
                        <Badge variant="secondary">
                          授权公告 {formatDate(patent.grant_date)}
                        </Badge>
                      )}
                    </div>

                    <div className="flex flex-col gap-2">
                      <h1 className="text-foreground text-2xl font-semibold text-balance lg:text-3xl">
                        {patent.title}
                      </h1>
                      <p className="text-muted-foreground text-sm leading-6">
                        申请人 {joinNames(patent.applicants)}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2 lg:w-[360px]">
                  <MetricCard label="申请号" value={patent.app_number} />
                  <MetricCard
                    label="申请日"
                    value={formatDate(patent.app_date)}
                  />
                  <MetricCard label="授权公告号" value={patent.grant_number} />
                  <MetricCard
                    label="IPC 分类"
                    value={
                      patent.ipc_codes?.length
                        ? `${patent.ipc_codes.length} 项`
                        : undefined
                    }
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-card border-border">
            <CardContent className="flex flex-col gap-4 p-5">
              <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <p className="text-foreground text-sm font-medium">
                    页面导航
                  </p>
                  <p className="text-muted-foreground text-sm">
                    快速跳转到正文区块与说明书章节
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {contentSections.map((section) => (
                    <NavChip
                      key={section.id}
                      href={`#${section.id}`}
                      label={section.label}
                      meta={section.meta}
                    />
                  ))}
                </div>
              </div>

              {hasDescription && (
                <div className="border-border flex flex-wrap gap-2 border-t pt-4">
                  {descriptionSections.map((section) => (
                    <NavChip
                      key={section.id}
                      href={`#${section.id}`}
                      label={section.title}
                    />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <div className="grid gap-6 xl:grid-cols-[320px_minmax(0,1fr)]">
            <div className="flex flex-col gap-6 xl:sticky xl:top-6 xl:self-start">
              <Card className="bg-card border-border">
                <CardHeader>
                  <CardTitle className="text-base font-medium">
                    内容概览
                  </CardTitle>
                  <CardDescription>
                    当前专利详情的正文与主体覆盖情况
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid grid-cols-2 gap-3">
                  {overviewMetrics.map((metric) => (
                    <MetricCard
                      key={metric.label}
                      label={metric.label}
                      value={metric.value}
                    />
                  ))}
                </CardContent>
              </Card>

              <Card className="bg-card border-border">
                <CardHeader>
                  <CardTitle className="text-base font-medium">
                    参与主体
                  </CardTitle>
                  <CardDescription>
                    优先展示阅读时最常查看的主体信息
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  <InfoItem
                    icon={Building}
                    label="申请人"
                    value={joinNames(patent.applicants)}
                  />
                  <InfoItem
                    icon={User}
                    label="发明人"
                    value={joinText(patent.inventors)}
                  />
                  {patent.assignees?.length > 0 && (
                    <InfoItem
                      icon={Building}
                      label="专利权人"
                      value={joinNames(patent.assignees)}
                    />
                  )}
                  {patent.agents?.length > 0 && (
                    <>
                      <InfoItem
                        icon={Building}
                        label="代理机构"
                        value={joinText(patent.agents.map((a) => a.agency))}
                      />
                      <InfoItem
                        icon={User}
                        label="代理人"
                        value={joinText(patent.agents.map((a) => a.agent))}
                      />
                    </>
                  )}
                  {patent.examiners?.length > 0 && (
                    <InfoItem
                      icon={User}
                      label="审查员"
                      value={joinText(patent.examiners)}
                    />
                  )}
                </CardContent>
              </Card>

              <Card className="bg-card border-border">
                <CardHeader>
                  <CardTitle className="text-base font-medium">
                    文献信息
                  </CardTitle>
                  <CardDescription>归档编号和关键时间节点</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  <InfoItem
                    icon={FileText}
                    label="申请号"
                    value={patent.app_number}
                  />
                  <InfoItem
                    icon={Calendar}
                    label="申请日"
                    value={formatDate(patent.app_date)}
                  />
                  <InfoItem
                    icon={FileText}
                    label="公开号"
                    value={patent.doc_number}
                  />
                  <InfoItem
                    icon={Calendar}
                    label="公开日"
                    value={formatDate(patent.pub_date)}
                  />
                  <InfoItem
                    icon={FileText}
                    label="授权公告号"
                    value={patent.grant_number}
                  />
                  <InfoItem
                    icon={Calendar}
                    label="授权公告日"
                    value={formatDate(patent.grant_date)}
                  />
                  <InfoItem icon={Tag} label="文档状态" value={patent.status} />
                  <InfoItem
                    icon={FileText}
                    label="来源文件"
                    value={patent.source_file}
                  />
                </CardContent>
              </Card>

              <Card className="bg-card border-border">
                <CardHeader>
                  <CardTitle className="text-base font-medium">
                    技术分类
                  </CardTitle>
                  <CardDescription>分类号与数据归档补充信息</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  <InfoItem
                    icon={Tag}
                    label="专利类型"
                    value={isInvention ? '发明授权' : '实用新型'}
                  />
                  <InfoItem
                    icon={Tag}
                    label="批次 ID"
                    value={patent.batch_id}
                  />
                  <div className="flex flex-col gap-3">
                    <div className="text-muted-foreground flex items-center gap-2 text-xs tracking-wide uppercase">
                      <Tag aria-hidden="true" className="size-4" />
                      <span>IPC 分类号</span>
                    </div>
                    {patent.ipc_codes?.length ? (
                      <div className="flex flex-wrap gap-2">
                        {patent.ipc_codes.map((code) => (
                          <Badge
                            key={code}
                            variant="secondary"
                            className="font-mono text-xs"
                          >
                            {code}
                          </Badge>
                        ))}
                      </div>
                    ) : (
                      <p className="text-muted-foreground text-sm">无分类号</p>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>

            <div className="flex flex-col gap-6">
              <Card
                id="section-abstract"
                className="bg-card border-border scroll-mt-28"
              >
                <CardHeader>
                  <CardTitle className="text-base font-medium">摘要</CardTitle>
                  <CardDescription>专利内容的核心概览</CardDescription>
                </CardHeader>
                <CardContent>
                  {patent.abstract ? (
                    <div className="flex flex-col gap-5">
                      <p className="text-muted-foreground text-sm leading-7 whitespace-pre-wrap">
                        {patent.abstract}
                      </p>
                      {abstractImage && (
                        <figure className="bg-secondary/30 overflow-hidden rounded-lg border">
                          <div className="bg-background relative min-h-[220px]">
                            <Image
                              src={`/api/patent-images/${abstractImage.id}`}
                              alt={`${patent.title} 摘要附图`}
                              fill
                              unoptimized
                              sizes="(max-width: 1280px) 100vw, 896px"
                              className="object-contain"
                            />
                          </div>
                          <figcaption className="text-muted-foreground border-t px-4 py-2 text-xs">
                            图1
                          </figcaption>
                        </figure>
                      )}
                    </div>
                  ) : (
                    <p className="text-muted-foreground text-sm italic">
                      无摘要信息
                    </p>
                  )}
                </CardContent>
              </Card>

              {bodyImages.length > 0 && (
                <Card
                  id="section-images"
                  className="bg-card border-border scroll-mt-28"
                >
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base font-medium">
                      <Images
                        aria-hidden="true"
                        className="text-muted-foreground size-4"
                      />
                      附图
                    </CardTitle>
                    <CardDescription>
                      说明书附图（摘要附图见摘要区域）
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="grid gap-4 md:grid-cols-2">
                      {bodyImages.map((image, index) => {
                        const figureNum = index + 1
                        const caption = drawingCaptions.get(figureNum)
                        return (
                          <figure
                            key={image.id}
                            className="bg-secondary/30 overflow-hidden rounded-lg border"
                          >
                            <div className="bg-background relative aspect-[4/3]">
                              <Image
                                src={`/api/patent-images/${image.id}`}
                                alt={`${patent.title} 图${figureNum}`}
                                fill
                                unoptimized
                                sizes="(max-width: 768px) 100vw, 50vw"
                                className="object-contain"
                              />
                            </div>
                            <figcaption className="text-muted-foreground flex items-center justify-between gap-3 border-t px-3 py-2 text-xs">
                              <span className="truncate">
                                图{figureNum}
                                {caption ? `：${caption}` : ''}
                              </span>
                            </figcaption>
                          </figure>
                        )
                      })}
                    </div>
                  </CardContent>
                </Card>
              )}

              {hasClaims && (
                <Card
                  id="section-claims"
                  className="bg-card border-border scroll-mt-28"
                >
                  <CardHeader>
                    <CardTitle className="text-base font-medium">
                      权利要求
                    </CardTitle>
                    <CardDescription>
                      优先展示结构化条目，便于逐条阅读
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {structuredClaims.length > 0 ? (
                      <div className="flex flex-col gap-4">
                        {structuredClaims.map((claim) => (
                          <section
                            key={claim.claim_num}
                            className="bg-secondary/30 rounded-xl border p-4"
                          >
                            <p className="text-foreground mb-3 text-sm font-medium">
                              权利要求 {claim.claim_num}
                            </p>
                            <p className="text-muted-foreground text-sm leading-7 whitespace-pre-wrap">
                              {claim.claim_text}
                            </p>
                          </section>
                        ))}
                      </div>
                    ) : (
                      <p className="text-muted-foreground text-sm leading-7 whitespace-pre-wrap">
                        {patent.claims}
                      </p>
                    )}
                  </CardContent>
                </Card>
              )}

              {hasDescription && (
                <Card
                  id="section-description"
                  className="bg-card border-border scroll-mt-28"
                >
                  <CardHeader>
                    <CardTitle className="text-base font-medium">
                      说明书
                    </CardTitle>
                    <CardDescription>
                      按章节整理，减少长文本阅读负担
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-4">
                    <div className="flex flex-wrap gap-2">
                      {descriptionSections.map((section) => (
                        <NavChip
                          key={section.id}
                          href={`#${section.id}`}
                          label={section.title}
                        />
                      ))}
                    </div>
                  </CardContent>
                  <CardContent className="divide-border divide-y">
                    {descriptionSections.map((section) => (
                      <DescriptionSection
                        key={section.id}
                        id={section.id}
                        title={section.title}
                        content={section.content}
                      />
                    ))}
                  </CardContent>
                </Card>
              )}

              {hasCitations && (
                <Card
                  id="section-citations"
                  className="bg-card border-border scroll-mt-28"
                >
                  <CardHeader>
                    <CardTitle className="text-base font-medium">
                      引用文献
                    </CardTitle>
                    <CardDescription>支持快速查看现有引证记录</CardDescription>
                  </CardHeader>
                  <CardContent className="grid gap-3 md:grid-cols-2">
                    {patent.citations.map((citation, index) => (
                      <div
                        key={`${citation.country ?? 'citation'}-${citation.doc_number ?? index}`}
                        className="bg-secondary/30 rounded-xl border p-4"
                      >
                        <p className="text-foreground text-sm font-medium">
                          {joinText([
                            citation.country,
                            citation.doc_number,
                            citation.kind,
                          ])}
                        </p>
                        <p className="text-muted-foreground mt-2 text-sm">
                          公开日期 {citation.pub_date || '-'}
                        </p>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}

              <div className="flex justify-end">
                <a
                  href="#top"
                  className="text-muted-foreground hover:text-foreground text-sm transition-colors"
                >
                  返回顶部
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  )
}
