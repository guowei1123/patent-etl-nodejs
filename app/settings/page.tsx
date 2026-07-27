'use client'

import useSWR from 'swr'
import { AppShell } from '@/components/layout/app-shell'
import { Header } from '@/components/layout/header'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Separator } from '@/components/ui/separator'
import { Spinner } from '@/components/ui/spinner'
import { toast } from 'sonner'
import {
  Database,
  Server,
  Cloud,
  ListTree,
  CheckCircle2,
  XCircle,
  RefreshCw,
} from 'lucide-react'
import { cn } from '@/lib/utils'

const fetcher = (url: string) => fetch(url).then((res) => res.json())

function ConnectionStatus({
  loading,
  status,
}: {
  loading: boolean
  status?: { success: boolean; error?: string } | null
}) {
  if (loading)
    return <Spinner className="text-muted-foreground" />
  if (status?.success)
    return (
      <Badge variant="outline" className="border-success/50 text-success">
        <CheckCircle2 aria-hidden="true" />
        已连接
      </Badge>
    )
  if (status && !status.success && status.error)
    return (
      <Badge variant="destructive">
        <XCircle aria-hidden="true" />
        连接失败
      </Badge>
    )
  return (
    <Badge variant="outline" className="border-warning/50 text-warning">
      未配置
    </Badge>
  )
}

function ReadOnlyField({
  id,
  label,
  value,
  placeholder = '未配置',
}: {
  id: string
  label: string
  value?: string | number | null
  placeholder?: string
}) {
  return (
    <Field data-disabled>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        value={value ?? ''}
        placeholder={placeholder}
        disabled
        className="font-mono text-sm"
      />
    </Field>
  )
}

export default function SettingsPage() {
  const {
    data: dbStatus,
    mutate: mutateDb,
    isValidating: loadingDb,
  } = useSWR<{
    success: boolean
    error?: string
    database_url_set: boolean
  }>('/api/db/init', fetcher)

  const {
    data: ftpStatus,
    mutate: mutateFtp,
    isValidating: loadingFtp,
  } = useSWR<{
    success: boolean
    error?: string
  }>('/api/ftp/test', fetcher)

  const {
    data: ossStatus,
    mutate: mutateOss,
    isValidating: loadingOss,
  } = useSWR<{
    success: boolean
    error?: string
  }>('/api/oss/test', fetcher)

  const {
    data: redisStatus,
    mutate: mutateRedis,
    isValidating: loadingRedis,
  } = useSWR<{
    success: boolean
    error?: string
    configured: boolean
  }>('/api/redis/test', fetcher)

  const { data: config } = useSWR<{
    ftp: { configured: boolean; host: string; port: string; user: string }
    oss: {
      configured: boolean
      bucket: string
      region: string
      endpoint: string
    }
    database: {
      configured: boolean
      type: string
      host: string
      port: string
      db: string
      user: string
    }
    redis: {
      configured: boolean
      host: string
      port: string
      db: string
    }
  }>('/api/config', fetcher)

  const retestFtp = async () => {
    const res = await fetch('/api/ftp/test', { method: 'POST' })
    const result = await res.json()
    mutateFtp(result, { revalidate: false })
    if (result?.success) toast.success('FTP 连接成功')
    else toast.error(result?.error || 'FTP 连接失败')
  }

  const retestOss = async () => {
    const res = await fetch('/api/oss/test', { method: 'POST' })
    const result = await res.json()
    mutateOss(result, { revalidate: false })
    if (result?.success) toast.success('OSS 连接成功')
    else toast.error(result?.error || 'OSS 连接失败')
  }

  const retestDb = async () => {
    const res = await fetch('/api/db/init', { method: 'POST' })
    const result = await res.json()
    mutateDb(result, { revalidate: false })
    if (result?.success) toast.success('数据库连接成功')
    else toast.error(result?.error || '数据库连接失败')
  }

  const retestRedis = async () => {
    const res = await fetch('/api/redis/test', { method: 'POST' })
    const result = await res.json()
    mutateRedis(result, { revalidate: false })
    if (result?.success) toast.success('Redis 连接成功')
    else toast.error(result?.error || 'Redis 连接失败')
  }

  return (
    <AppShell>
      <Header title="系统设置" description="服务连接状态" />

      <div className="flex max-w-3xl flex-col gap-6 p-6">
        {/* FTP */}
        <Card className="bg-card border-border">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div
                className={cn(
                  'flex size-10 items-center justify-center rounded-lg',
                  ftpStatus?.success ? 'bg-success/20' : 'bg-secondary',
                )}
              >
                <Server
                  className={cn(
                    'size-5',
                    ftpStatus?.success
                      ? 'text-success'
                      : 'text-muted-foreground',
                  )}
                  aria-hidden="true"
                />
              </div>
              <div className="flex-1">
                <CardTitle className="text-base">FTP 服务器</CardTitle>
                <CardDescription>中国知识产权局 FTP 连接</CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <ConnectionStatus
                  loading={loadingFtp}
                  status={config?.ftp.configured ? ftpStatus : null}
                />
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <FieldGroup className="contents">
                <ReadOnlyField id="ftp-host" label="主机地址" value={config?.ftp.host} />
                <ReadOnlyField id="ftp-port" label="端口" value={config?.ftp.port || '21'} />
                <ReadOnlyField id="ftp-user" label="用户名" value={config?.ftp.user} />
              </FieldGroup>
            </div>

            {ftpStatus && !ftpStatus.success && ftpStatus.error && (
              <Alert variant="destructive">
                <AlertDescription>{ftpStatus.error}</AlertDescription>
              </Alert>
            )}

            <Separator />
            <div className="flex items-center justify-end">
              <Button
                onClick={retestFtp}
                disabled={loadingFtp || !config?.ftp.configured}
              >
                <RefreshCw data-icon="inline-start" aria-hidden="true" />
                重新测试
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* OSS */}
        <Card className="bg-card border-border">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div
                className={cn(
                  'flex size-10 items-center justify-center rounded-lg',
                  ossStatus?.success ? 'bg-success/20' : 'bg-secondary',
                )}
              >
                <Cloud
                  className={cn(
                    'size-5',
                    ossStatus?.success
                      ? 'text-success'
                      : 'text-muted-foreground',
                  )}
                  aria-hidden="true"
                />
              </div>
              <div className="flex-1">
                <CardTitle className="text-base">阿里云 OSS</CardTitle>
                <CardDescription>对象存储服务</CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <ConnectionStatus
                  loading={loadingOss}
                  status={config?.oss.configured ? ossStatus : null}
                />
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <FieldGroup className="contents">
                <ReadOnlyField id="oss-bucket" label="Bucket" value={config?.oss.bucket} />
                <ReadOnlyField id="oss-region" label="Region" value={config?.oss.region} />
                <ReadOnlyField id="oss-endpoint" label="Endpoint" value={config?.oss.endpoint} />
              </FieldGroup>
            </div>

            {ossStatus && !ossStatus.success && ossStatus.error && (
              <Alert variant="destructive">
                <AlertDescription>{ossStatus.error}</AlertDescription>
              </Alert>
            )}

            <Separator />
            <div className="flex items-center justify-end">
              <Button
                onClick={retestOss}
                disabled={loadingOss || !config?.oss.configured}
              >
                <RefreshCw data-icon="inline-start" aria-hidden="true" />
                重新测试
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Database */}
        <Card className="bg-card border-border">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div
                className={cn(
                  'flex size-10 items-center justify-center rounded-lg',
                  dbStatus?.success ? 'bg-success/20' : 'bg-secondary',
                )}
              >
                <Database
                  className={cn(
                    'size-5',
                    dbStatus?.success
                      ? 'text-success'
                      : 'text-muted-foreground',
                  )}
                  aria-hidden="true"
                />
              </div>
              <div className="flex-1">
                <CardTitle className="text-base">专利数据库</CardTitle>
                <CardDescription>
                  {config?.database.type === 'sqlite'
                    ? '本地 SQLite'
                    : '本地 PostgreSQL'}
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                {loadingDb ? (
                  <Spinner className="text-muted-foreground" />
                ) : dbStatus?.success ? (
                  <Badge variant="outline" className="border-success/50 text-success">
                    <CheckCircle2 aria-hidden="true" />
                    已连接
                  </Badge>
                ) : dbStatus?.database_url_set ? (
                  <Badge variant="destructive">
                    <XCircle aria-hidden="true" />
                    连接失败
                  </Badge>
                ) : (
                  <Badge variant="outline" className="border-warning/50 text-warning">
                    未配置
                  </Badge>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <FieldGroup className="contents">
                <ReadOnlyField id="db-host" label="主机地址" value={config?.database.host} />
                <ReadOnlyField id="db-port" label="端口" value={config?.database.port || '5432'} />
                <ReadOnlyField id="db-name" label="数据库" value={config?.database.db} />
                <ReadOnlyField id="db-user" label="用户名" value={config?.database.user} />
              </FieldGroup>
            </div>

            {dbStatus?.error && (
              <Alert variant="destructive">
                <AlertDescription>{dbStatus.error}</AlertDescription>
              </Alert>
            )}

            <Separator />
            <div className="flex items-center justify-end">
              <Button onClick={retestDb} disabled={loadingDb}>
                <RefreshCw data-icon="inline-start" aria-hidden="true" />
                重新测试
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Redis 分类字典 */}
        <Card className="bg-card border-border">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div
                className={cn(
                  'flex size-10 items-center justify-center rounded-lg',
                  redisStatus?.success ? 'bg-success/20' : 'bg-secondary',
                )}
              >
                <ListTree
                  className={cn(
                    'size-5',
                    redisStatus?.success
                      ? 'text-success'
                      : 'text-muted-foreground',
                  )}
                  aria-hidden="true"
                />
              </div>
              <div className="flex-1">
                <CardTitle className="text-base">Redis 分类字典</CardTitle>
                <CardDescription>本地 Redis 中的 IPC 分类数据</CardDescription>
              </div>
              <div className="flex items-center gap-2">
                {loadingRedis ? (
                  <Spinner className="text-muted-foreground" />
                ) : redisStatus?.success ? (
                  <Badge variant="outline" className="border-success/50 text-success">
                    <CheckCircle2 aria-hidden="true" />
                    已连接
                  </Badge>
                ) : redisStatus?.configured ? (
                  <Badge variant="destructive">
                    <XCircle aria-hidden="true" />
                    连接失败
                  </Badge>
                ) : (
                  <Badge variant="outline" className="border-warning/50 text-warning">
                    未配置
                  </Badge>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <FieldGroup className="contents">
                <ReadOnlyField id="redis-host" label="主机地址" value={config?.redis.host} />
                <ReadOnlyField id="redis-port" label="端口" value={config?.redis.port || '6379'} />
                <ReadOnlyField id="redis-db" label="数据库" value={config?.redis.db || '0'} />
              </FieldGroup>
            </div>

            {redisStatus?.error && (
              <Alert variant="destructive">
                <AlertDescription>{redisStatus.error}</AlertDescription>
              </Alert>
            )}

            <Separator />
            <div className="flex items-center justify-end">
              <Button
                onClick={retestRedis}
                disabled={loadingRedis || !config?.redis.configured}
              >
                <RefreshCw data-icon="inline-start" aria-hidden="true" />
                重新测试
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  )
}
