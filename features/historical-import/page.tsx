'use client'

import { useState } from 'react'
import Image from 'next/image'
import useSWR from 'swr'
import { toast } from 'sonner'
import { Archive, LoaderCircle, Play, ScanSearch } from 'lucide-react'
import { AppShell } from '@/components/layout/app-shell'
import { Header } from '@/components/layout/header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Field,
  FieldLabel,
  FieldDescription,
  FieldGroup,
  FieldSet,
  FieldLegend,
} from '@/components/ui/field'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from '@/components/ui/empty'
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table'
import { configSchema, type ImportConfig, type HistoryJob } from './model'

const initial: ImportConfig = {
  ...configSchema.parse({
    stage: 'metadata',
    excelPath: '_',
    descriptionPath: '_',
    claimsPath: '_',
    pdfPath: 'F:/历史数据/PDF文件-发明申请（第二部分）',
    columns: {},
  }),
  excelPath: '',
  descriptionPath: '',
  claimsPath: '',
}

const fetcher = async (url: string) => {
  const response = await fetch(url)
  const body = await response.json()
  if (!response.ok) throw new Error(body.error || '读取任务失败，请刷新重试')
  return body
}

function imageRoleLabel(role?: string) {
  return (
    (
      {
        abstract: '摘要附图',
        drawing: '说明书附图',
        body_figure: '正文插图',
        table: '正文表格',
        formula: '正文公式',
      } as Record<string, string>
    )[role || 'drawing'] || '正文插图'
  )
}
const labels = {
  pending: '待处理',
  processing: '处理中',
  completed: '已完成',
  failed: '失败',
}
const stageLabels = {
  metadata: '基础信息',
  text: '正文',
  images: '附图',
  all: '旧版全量',
}
const number = new Intl.NumberFormat('zh-CN')
const dateFormat = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'short',
  timeStyle: 'short',
})

export default function HistoricalImportPage() {
  const [config, setConfig] = useState<ImportConfig>(initial)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [inspection, setInspection] = useState<Record<
    string,
    { fileCount: number; samples: Array<{ file: string; columns: string[] }> }
  > | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [imagePreview, setImagePreview] = useState<{
    jobId: string
    publication: string
    uniqueImages: number
    images: Array<{
      file_name: string
      page: number
      width: number
      height: number
      image_role?: string
      figure_label?: string
      canonical: string
    }>
  } | null>(null)
  const [cleanup, setCleanup] = useState<{
    jobId: string
    keys: string[]
  } | null>(null)
  const {
    data,
    error: loadError,
    isLoading,
    mutate,
  } = useSWR<{ data: HistoryJob[] }>('/api/historical-import', fetcher, {
    refreshInterval: 3000,
  })
  const jobs = data?.data || []
  const job = jobs.find((item) => item.id === selected) || jobs[0]
  const preview = jobs.find(
    (item) =>
      item.mode === 'preview' &&
      item.status === 'completed' &&
      JSON.stringify(item.config) === JSON.stringify(config),
  )
  const active = jobs.some((item) =>
    ['pending', 'processing'].includes(item.status),
  )
  async function showImages(publication: string) {
    if (!job) return
    setBusy('images')
    try {
      const response = await fetch(
        `/api/historical-import?id=${job.id}&publication=${publication}`,
      )
      const body = await response.json()
      if (!response.ok) throw new Error(body.error)
      setImagePreview({ ...body.data, jobId: job.id })
    } catch {
      toast.error('无法预览附图，请检查提取结果或重新生成预览')
    } finally {
      setBusy(null)
    }
  }

  async function act(action: 'inspect' | 'preview' | 'import') {
    if (
      action !== 'import' &&
      !(
        document.getElementById('history-form') as HTMLFormElement
      ).reportValidity()
    )
      return
    setBusy(action)
    setError('')
    try {
      const response = await fetch('/api/historical-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          action === 'import'
            ? { action, previewId: preview?.id }
            : { action, config },
        ),
      })
      const body = await response.json()
      if (!response.ok)
        throw new Error(body.error || '操作失败，请检查配置后重试')
      if (action === 'inspect') {
        setInspection(body.data)
        toast.success('来源字段已读取，请核对列名映射')
      } else {
        setSelected(body.data.id)
        if (action === 'preview') setConfig(body.data.config)
        await mutate()
        toast.success(
          action === 'preview' ? '预览任务已创建' : '导入任务已创建',
        )
      }
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : '操作失败，请重试'
      setError(message)
      toast.error(message)
    } finally {
      setBusy(null)
    }
  }
  async function previewCleanup(jobId: string) {
    setBusy('cleanup-preview')
    try {
      const body = await fetcher(
        `/api/historical-import?id=${jobId}&cleanup=true`,
      )
      if (!body.data.length) toast.info('没有可清理的无引用图片')
      else setCleanup({ jobId, keys: body.data })
    } catch {
      toast.error('无法读取清理清单，请检查数据库连接')
    } finally {
      setBusy(null)
    }
  }
  async function runCleanup() {
    if (!cleanup) return
    setBusy('cleanup')
    try {
      const response = await fetch('/api/historical-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'cleanup',
          jobId: cleanup.jobId,
          keys: cleanup.keys,
        }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error)
      toast.success(`已清理 ${body.data} 个无引用图片对象`)
      setCleanup(null)
    } catch (caught) {
      toast.error(
        caught instanceof Error ? caught.message : '清理失败，请重新预览',
      )
    } finally {
      setBusy(null)
    }
  }
  const paths: Array<
    [
      keyof Pick<
        ImportConfig,
        'excelPath' | 'descriptionPath' | 'claimsPath' | 'pdfPath'
      >,
      string,
      string,
    ]
  > = [
    ['excelPath', '基础信息 Excel', '填写 .xlsx 文件或包含 Excel 的目录'],
    ['descriptionPath', '说明书 Parquet', '填写 .parquet 文件或目录'],
    ['claimsPath', '权利要求 Parquet', '填写 .parquet 文件或目录'],
    ['pdfPath', '附图 PDF', '填写 PDF、TAR、ZIP 文件或目录'],
  ]
  const visiblePaths = paths.filter(
    ([key]) =>
      config.stage === 'all' ||
      (config.stage === 'metadata'
        ? key === 'excelPath'
        : config.stage === 'images'
          ? key === 'pdfPath'
          : ['descriptionPath', 'claimsPath'].includes(key)),
  )
  const mapping: Array<[keyof ImportConfig['columns'], string]> = [
    ['publication', '公开（公告）号'],
    ['application', '申请号'],
    ['title', '中文名称'],
    ['date', '公开（公告）日'],
    ['grant', '授权公告号'],
    ['grantDate', '授权公告日'],
    ['abstract', '中文摘要'],
    ['applicant', '申请人'],
    ['inventor', '发明人'],
    ['ipc', 'IPC'],
  ]
  return (
    <AppShell>
      <Header
        title="历史数据导入"
        description="分阶段导入基础信息、正文与附图，按公开号补齐数据库"
        onRefresh={() => mutate()}
      />
      <main className="flex min-w-0 flex-col gap-6 p-6">
        <Alert>
          <Archive aria-hidden="true" />
          <AlertTitle>授权版本优先</AlertTitle>
          <AlertDescription>
            基础信息、正文与附图可分次导入，正文也可单独补入说明书或权利要求。按完整公开号匹配，授权资料全部补齐后才替换申请记录。原始
            Excel、Parquet 和压缩包不会自动删除。
          </AlertDescription>
        </Alert>
        {(error || loadError) && (
          <Alert variant="destructive">
            <AlertTitle>需要处理</AlertTitle>
            <AlertDescription>{error || loadError.message}</AlertDescription>
          </Alert>
        )}
        <form
          id="history-form"
          onSubmit={(event) => {
            event.preventDefault()
            void act('preview')
          }}
          className="bg-card flex flex-col gap-6 rounded-lg border p-5"
        >
          <FieldSet>
            <FieldLegend>导入阶段</FieldLegend>
            <RadioGroup
              value={config.stage}
              onValueChange={(stage: ImportConfig['stage']) => {
                setConfig({ ...config, stage })
                setInspection(null)
              }}
              className="grid gap-3 sm:grid-cols-3"
            >
              {(
                [
                  ['metadata', '基础信息'],
                  ['text', '说明书与权利要求'],
                  ['images', '附图提取与导入'],
                ] as const
              ).map(([value, label]) => (
                <Field key={value} orientation="horizontal">
                  <RadioGroupItem id={`stage-${value}`} value={value} />
                  <FieldLabel htmlFor={`stage-${value}`}>{label}</FieldLabel>
                </Field>
              ))}
            </RadioGroup>
            <FieldDescription>
              三类数据可任意顺序导入，以完整公开号建立或补齐同一条记录。每件文献独立事务，失败记录可重试。
            </FieldDescription>
          </FieldSet>
          <FieldSet>
            <FieldLegend>数据来源</FieldLegend>
            <FieldDescription>
              {config.stage === 'images'
                ? '目标 PDF 先解压，再提取附图页主体、正文插图、表格与公式。压缩包检查最多展示 10 项样例。'
                : config.stage === 'text'
                  ? '至少填写一种 Parquet 来源。按完整公开号建立或更新记录，无需先提供 Excel。'
                  : '路径指运行本工作台的服务器本机路径。目录中的文件会递归读取，Excel 默认使用第一个工作表。'}
            </FieldDescription>
            <FieldGroup className="grid gap-4 lg:grid-cols-2">
              {visiblePaths.map(([key, label, placeholder]) => (
                <Field key={key}>
                  <FieldLabel htmlFor={key}>{label}</FieldLabel>
                  <Input
                    id={key}
                    required={config.stage !== 'text'}
                    value={config[key]}
                    placeholder={placeholder}
                    onChange={(event) =>
                      setConfig({ ...config, [key]: event.target.value })
                    }
                  />
                </Field>
              ))}
            </FieldGroup>
          </FieldSet>
          <details className="rounded-lg border p-4">
            <summary className="cursor-pointer font-medium focus-visible:outline-offset-4">
              列名映射与处理范围
            </summary>
            <div className="mt-4 flex flex-col gap-5">
              {['metadata', 'all'].includes(config.stage) && (
                <FieldSet>
                  <FieldLegend>Excel 列名</FieldLegend>
                  <FieldGroup className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                    {mapping.map(([key, label]) => (
                      <Field key={key}>
                        <FieldLabel htmlFor={`column-${key}`}>
                          {label}
                        </FieldLabel>
                        <Input
                          id={`column-${key}`}
                          value={config.columns[key]}
                          onChange={(event) =>
                            setConfig({
                              ...config,
                              columns: {
                                ...config.columns,
                                [key]: event.target.value,
                              },
                            })
                          }
                        />
                      </Field>
                    ))}
                  </FieldGroup>
                </FieldSet>
              )}
              <FieldGroup className="grid gap-4 sm:grid-cols-2">
                {(
                  [
                    ['descriptionKey', '说明书公开号列'],
                    ['descriptionText', '说明书正文列'],
                    ['claimsKey', '权利要求公开号列'],
                    ['claimsText', '权利要求正文列'],
                    ['sheet', 'Excel 工作表名称（可选）'],
                  ] as const
                )
                  .filter(
                    ([key]) =>
                      config.stage === 'all' ||
                      (key === 'sheet'
                        ? config.stage === 'metadata'
                        : config.stage === 'text'),
                  )
                  .map(([key, label]) => (
                    <Field key={key}>
                      <FieldLabel htmlFor={key}>{label}</FieldLabel>
                      <Input
                        id={key}
                        value={config[key]}
                        onChange={(event) =>
                          setConfig({ ...config, [key]: event.target.value })
                        }
                      />
                    </Field>
                  ))}
                <Field>
                  <FieldLabel htmlFor="beforeDate">公告日期早于</FieldLabel>
                  <Input
                    id="beforeDate"
                    type="date"
                    required
                    value={config.beforeDate}
                    onChange={(event) =>
                      setConfig({ ...config, beforeDate: event.target.value })
                    }
                  />
                  <FieldDescription>
                    已知日期按范围筛选；日期缺失时先保存待补齐记录，补入日期后再归入公告批次。
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="limit">候选处理数量</FieldLabel>
                  <Input
                    id="limit"
                    type="number"
                    min={0}
                    max={1000000}
                    required
                    value={config.limit}
                    onChange={(event) =>
                      setConfig({
                        ...config,
                        limit: Number(event.target.value),
                      })
                    }
                  />
                  <FieldDescription>
                    按公开号关联并选择候选后限制数量。0 表示全部，建议先试跑 100
                    件。
                  </FieldDescription>
                </Field>
                {['images', 'all'].includes(config.stage) && (
                  <Field>
                    <FieldLabel htmlFor="noDrawingNumbers">
                      已确认无附图的公开号
                    </FieldLabel>
                    <Textarea
                      id="noDrawingNumbers"
                      placeholder="每行一项，例如 CN123456789B"
                      value={config.noDrawingNumbers.join('\n')}
                      onChange={(event) =>
                        setConfig({
                          ...config,
                          noDrawingNumbers: event.target.value
                            .split(/\s+/)
                            .filter(Boolean),
                        })
                      }
                    />
                    <FieldDescription>
                      仅填写人工确认无附图的文献，其他文献缺少附图时不会入库。
                    </FieldDescription>
                  </Field>
                )}
              </FieldGroup>
            </div>
          </details>
          <FieldGroup className="gap-3">
            {['images', 'all'].includes(config.stage) && (
              <Field orientation="horizontal">
                <Checkbox
                  id="ocr"
                  checked={config.ocr}
                  onCheckedChange={(checked) =>
                    setConfig({ ...config, ocr: checked === true })
                  }
                />
                <FieldLabel htmlFor="ocr">
                  扫描 PDF 使用 OCR 识别附图页
                </FieldLabel>
              </Field>
            )}
            <Field orientation="horizontal">
              <Checkbox
                id="cleanupApplications"
                checked={config.cleanupApplications}
                onCheckedChange={(checked) =>
                  setConfig({
                    ...config,
                    cleanupApplications: checked === true,
                  })
                }
              />
              <FieldLabel htmlFor="cleanupApplications">
                授权数据完整入库后删除同申请的申请记录
              </FieldLabel>
            </Field>
            <FieldDescription>
              申请号、基础信息和授权正文、附图齐备后执行清理；不删除来源文件。无引用图片对象会进入清理清单。
            </FieldDescription>
          </FieldGroup>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button
              type="button"
              variant="outline"
              disabled={!!busy || active}
              onClick={() => act('inspect')}
            >
              {busy === 'inspect' ? (
                <LoaderCircle
                  data-icon="inline-start"
                  className="animate-spin motion-reduce:animate-none"
                />
              ) : (
                <ScanSearch data-icon="inline-start" />
              )}
              {config.stage === 'images' ? '检查压缩包' : '检查来源字段'}
            </Button>
            <Button type="submit" disabled={!!busy || active}>
              {busy === 'preview' && (
                <LoaderCircle
                  data-icon="inline-start"
                  className="animate-spin motion-reduce:animate-none"
                />
              )}
              生成导入预览
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={!!busy || active || !preview || !preview.summary.ready}
              onClick={() => act('import')}
            >
              <Play data-icon="inline-start" />
              开始导入
            </Button>
          </div>
          <p className="text-muted-foreground text-sm">
            修改阶段或配置后需要重新预览。开始导入只写入当前阶段，不清空其他阶段已有内容。
          </p>
        </form>
        {inspection && (
          <section className="flex flex-col gap-3 rounded-lg border p-5">
            <h2 className="font-medium">来源字段检查</h2>
            {Object.entries(inspection).map(([key, source]) => (
              <details key={key}>
                <summary className="cursor-pointer text-sm focus-visible:outline-offset-4">
                  {paths.find(([name]) => name === key)?.[1]} ·{' '}
                  {number.format(source.fileCount)} 个文件
                </summary>
                {source.samples.map((file) => (
                  <div
                    key={file.file}
                    className="mt-2 flex min-w-0 flex-col gap-2 text-sm"
                  >
                    <p className="break-words" translate="no">
                      {file.file}
                    </p>
                    <p className="text-muted-foreground break-words">
                      {file.columns.join('、')}
                    </p>
                  </div>
                ))}
              </details>
            ))}
          </section>
        )}
        <section className="flex min-w-0 flex-col gap-4" aria-live="polite">
          <h2 className="font-medium">任务进度与预览</h2>
          {isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : !job ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>尚未创建历史导入任务</EmptyTitle>
                <EmptyDescription>
                  填写来源路径，检查列名后生成导入预览。
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <>
              <div className="bg-card flex flex-col gap-3 rounded-lg border p-5">
                <div className="flex flex-wrap items-center gap-3">
                  <Badge
                    variant={
                      job.status === 'failed' ? 'destructive' : 'secondary'
                    }
                  >
                    {labels[job.status]}
                  </Badge>
                  <span className="text-sm">
                    {job.mode === 'preview' ? '预览任务' : '导入任务'}·{' '}
                    {stageLabels[job.config.stage || 'all']}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {dateFormat.format(new Date(job.createdAt))}
                  </span>
                </div>
                <p className="text-sm break-words">{job.message}</p>
                <Progress
                  value={
                    job.status === 'completed'
                      ? 100
                      : job.summary.total
                        ? Math.min(
                            (job.processed / job.summary.total) * 100,
                            99,
                          )
                        : 0
                  }
                  aria-label="历史数据处理进度"
                />
                <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                  {(
                    [
                      ['候选文献', job.summary.total],
                      ['可导入', job.summary.ready],
                      ['待补齐', job.summary.blocked],
                      ['已导入', job.summary.imported],
                      ['已跳过', job.summary.skipped],
                      ['入库失败', job.summary.failed],
                      ['已清理申请记录', job.summary.removedApplications],
                    ] as const
                  ).map(([label, value]) => (
                    <div key={label}>
                      <p className="text-muted-foreground">{label}</p>
                      <p className="font-medium tabular-nums">
                        {number.format(value)}
                      </p>
                    </div>
                  ))}
                </div>
                <p
                  className="text-muted-foreground text-xs break-words"
                  translate="no"
                >
                  结果目录：data/historical-import/{job.id}
                </p>
                {['completed', 'failed'].includes(job.status) && (
                  <div className="flex flex-wrap gap-2">
                    <Button asChild variant="outline" size="sm">
                      <a
                        href={`/api/historical-import?id=${job.id}&report=results.jsonl`}
                      >
                        下载校验结果
                      </a>
                    </Button>
                    <Button asChild variant="outline" size="sm">
                      <a
                        href={`/api/historical-import?id=${job.id}&report=source-errors.jsonl`}
                      >
                        下载来源异常
                      </a>
                    </Button>
                    {job.mode === 'import' && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!!busy}
                        onClick={() => previewCleanup(job.id)}
                      >
                        预览无引用图片清理
                      </Button>
                    )}
                  </div>
                )}
              </div>
              <div className="overflow-x-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>公开号</TableHead>
                      <TableHead>名称</TableHead>
                      <TableHead>公告日期</TableHead>
                      <TableHead>校验结果</TableHead>
                      <TableHead>附图</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {job.sample.map((record) => (
                      <TableRow key={record.publication}>
                        <TableCell className="whitespace-nowrap" translate="no">
                          {record.publication}
                        </TableCell>
                        <TableCell className="max-w-72">
                          <span className="line-clamp-2 break-words">
                            {record.title || '标题待补齐'}
                          </span>
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          {record.date || '日期待补齐'}
                        </TableCell>
                        <TableCell className="max-w-96">
                          <span className="break-words">
                            {record.status === 'ready'
                              ? record.metadataPending
                                ? '可导入 · 基础信息待补齐'
                                : '可导入'
                              : record.reasons.join('；')}
                          </span>
                        </TableCell>
                        <TableCell>
                          {record.pdfManifest ? (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={!!busy}
                              onClick={() => showImages(record.publication)}
                            >
                              查看附图
                            </Button>
                          ) : (
                            '—'
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <p className="text-muted-foreground text-xs">
                展示前 30 件候选。完整结果见任务目录中的
                results.jsonl，来源异常见 source-errors.jsonl。
              </p>
            </>
          )}
        </section>
        {jobs.length > 0 && (
          <section className="flex flex-col gap-3">
            <h2 className="font-medium">最近任务</h2>
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>创建时间</TableHead>
                    <TableHead>操作</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead className="text-right">已处理</TableHead>
                    <TableHead>查看</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {jobs.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell className="whitespace-nowrap">
                        {dateFormat.format(new Date(item.createdAt))}
                      </TableCell>
                      <TableCell>
                        {item.mode === 'preview' ? '预览' : '导入'}·{' '}
                        {stageLabels[item.config.stage || 'all']}
                      </TableCell>
                      <TableCell>{labels[item.status]}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {number.format(item.processed)}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setSelected(item.id)
                            if (item.mode === 'preview') setConfig(item.config)
                          }}
                        >
                          查看任务
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>
        )}
      </main>
      <Dialog
        open={!!imagePreview}
        onOpenChange={(open) => {
          if (!open) setImagePreview(null)
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>附图预览 · {imagePreview?.publication}</DialogTitle>
            <DialogDescription>
              候选 {imagePreview?.images.length || 0} 张，去重后{' '}
              {imagePreview?.uniqueImages || 0}{' '}
              张资源。摘要和说明书用途分别保留；请核对提取区域是否完整。
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            {imagePreview?.images.map((image) => (
              <figure
                key={image.file_name}
                className="min-w-0 rounded-lg border p-3"
              >
                <Image
                  src={`/api/historical-import?id=${imagePreview.jobId}&publication=${imagePreview.publication}&image=${image.file_name}`}
                  width={image.width}
                  height={image.height}
                  unoptimized
                  alt={`${imageRoleLabel(image.image_role)}，原 PDF 第 ${image.page} 页`}
                  className="h-auto w-full"
                />
                <figcaption className="mt-2 text-sm break-words">
                  {imageRoleLabel(image.image_role)} · 第 {image.page} 页
                  {image.figure_label ? ` · ${image.figure_label}` : ''}
                  <br />
                  {image.canonical !== image.file_name
                    ? `复用 ${image.canonical}`
                    : image.file_name}
                </figcaption>
              </figure>
            ))}
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!cleanup}
        onOpenChange={(open) => {
          if (!open && busy !== 'cleanup') setCleanup(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>清理无引用图片</DialogTitle>
            <DialogDescription>
              下列 {cleanup?.keys.length || 0}{' '}
              个对象已失去专利引用。确认后永久删除对象及资产记录；执行时会再次检查引用。每次最多清理
              100 个。
            </DialogDescription>
          </DialogHeader>
          <ul
            className="flex max-h-64 flex-col gap-2 overflow-y-auto text-xs"
            translate="no"
          >
            {cleanup?.keys.map((key) => (
              <li key={key} className="break-words">
                {key}
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy === 'cleanup'}
              onClick={() => setCleanup(null)}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={busy === 'cleanup'}
              onClick={runCleanup}
            >
              {busy === 'cleanup' && (
                <LoaderCircle
                  data-icon="inline-start"
                  className="animate-spin motion-reduce:animate-none"
                />
              )}
              清理所列图片
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>
  )
}
