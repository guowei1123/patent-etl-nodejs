'use client'

import useSWR from 'swr'
import { Sidebar } from '@/components/layout/sidebar'
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
import { Label } from '@/components/ui/label'
import { toast } from 'sonner'
import {
  Database,
  Server,
  Cloud,
  CheckCircle2,
  XCircle,
  Loader2,
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
    return <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
  if (status?.success)
    return (
      <>
        <CheckCircle2 className="text-success h-4 w-4" />
        <span className="text-success text-sm">已连接</span>
      </>
    )
  if (status && !status.success && status.error)
    return (
      <>
        <XCircle className="text-destructive h-4 w-4" />
        <span className="text-destructive text-sm">连接失败</span>
      </>
    )
  return <span className="text-warning text-sm">未配置</span>
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
      host: string
      port: string
      db: string
      user: string
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

  return (
    <div className="flex min-h-screen">
      <Sidebar />

      <main className="flex-1 pl-64">
        <Header title="系统设置" description="服务连接状态" />

        <div className="max-w-3xl space-y-6 p-6">
          {/* FTP */}
          <Card className="bg-card border-border">
            <CardHeader>
              <div className="flex items-center gap-3">
                <div
                  className={cn(
                    'flex h-10 w-10 items-center justify-center rounded-lg',
                    ftpStatus?.success ? 'bg-success/20' : 'bg-secondary',
                  )}
                >
                  <Server
                    className={cn(
                      'h-5 w-5',
                      ftpStatus?.success
                        ? 'text-success'
                        : 'text-muted-foreground',
                    )}
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
            <CardContent className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-2">
                  <Label>主机地址</Label>
                  <Input
                    value={config?.ftp.host || ''}
                    placeholder="未配置"
                    disabled
                    className="font-mono text-sm"
                  />
                </div>
                <div className="space-y-2">
                  <Label>端口</Label>
                  <Input
                    value={config?.ftp.port || '21'}
                    disabled
                    className="font-mono text-sm"
                  />
                </div>
                <div className="space-y-2">
                  <Label>用户名</Label>
                  <Input
                    value={config?.ftp.user || ''}
                    placeholder="未配置"
                    disabled
                    className="font-mono text-sm"
                  />
                </div>
              </div>

              {ftpStatus && !ftpStatus.success && ftpStatus.error && (
                <div className="bg-destructive/10 rounded-lg p-3">
                  <p className="text-destructive text-sm">{ftpStatus.error}</p>
                </div>
              )}

              <div className="border-border flex items-center justify-end border-t pt-4">
                <Button
                  onClick={retestFtp}
                  disabled={loadingFtp || !config?.ftp.configured}
                >
                  <RefreshCw className="mr-2 h-4 w-4" />
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
                    'flex h-10 w-10 items-center justify-center rounded-lg',
                    ossStatus?.success ? 'bg-success/20' : 'bg-secondary',
                  )}
                >
                  <Cloud
                    className={cn(
                      'h-5 w-5',
                      ossStatus?.success
                        ? 'text-success'
                        : 'text-muted-foreground',
                    )}
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
            <CardContent className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-2">
                  <Label>Bucket</Label>
                  <Input
                    value={config?.oss.bucket || ''}
                    placeholder="未配置"
                    disabled
                    className="font-mono text-sm"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Region</Label>
                  <Input
                    value={config?.oss.region || ''}
                    placeholder="未配置"
                    disabled
                    className="font-mono text-sm"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Endpoint</Label>
                  <Input
                    value={config?.oss.endpoint || ''}
                    placeholder="未配置"
                    disabled
                    className="font-mono text-sm"
                  />
                </div>
              </div>

              {ossStatus && !ossStatus.success && ossStatus.error && (
                <div className="bg-destructive/10 rounded-lg p-3">
                  <p className="text-destructive text-sm">{ossStatus.error}</p>
                </div>
              )}

              <div className="border-border flex items-center justify-end border-t pt-4">
                <Button
                  onClick={retestOss}
                  disabled={loadingOss || !config?.oss.configured}
                >
                  <RefreshCw className="mr-2 h-4 w-4" />
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
                    'flex h-10 w-10 items-center justify-center rounded-lg',
                    dbStatus?.success ? 'bg-success/20' : 'bg-secondary',
                  )}
                >
                  <Database
                    className={cn(
                      'h-5 w-5',
                      dbStatus?.success
                        ? 'text-success'
                        : 'text-muted-foreground',
                    )}
                  />
                </div>
                <div className="flex-1">
                  <CardTitle className="text-base">PostgreSQL 数据库</CardTitle>
                  <CardDescription>数据存储</CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  {loadingDb ? (
                    <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
                  ) : dbStatus?.success ? (
                    <>
                      <CheckCircle2 className="text-success h-4 w-4" />
                      <span className="text-success text-sm">已连接</span>
                    </>
                  ) : dbStatus?.database_url_set ? (
                    <>
                      <XCircle className="text-destructive h-4 w-4" />
                      <span className="text-destructive text-sm">连接失败</span>
                    </>
                  ) : (
                    <span className="text-warning text-sm">未配置</span>
                  )}
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>主机地址</Label>
                  <Input
                    value={config?.database.host || ''}
                    placeholder="未配置"
                    disabled
                    className="font-mono text-sm"
                  />
                </div>
                <div className="space-y-2">
                  <Label>端口</Label>
                  <Input
                    value={config?.database.port || '5432'}
                    disabled
                    className="font-mono text-sm"
                  />
                </div>
                <div className="space-y-2">
                  <Label>数据库</Label>
                  <Input
                    value={config?.database.db || ''}
                    placeholder="未配置"
                    disabled
                    className="font-mono text-sm"
                  />
                </div>
                <div className="space-y-2">
                  <Label>用户名</Label>
                  <Input
                    value={config?.database.user || ''}
                    placeholder="未配置"
                    disabled
                    className="font-mono text-sm"
                  />
                </div>
              </div>

              {dbStatus?.error && (
                <div className="bg-destructive/10 rounded-lg p-3">
                  <p className="text-destructive text-sm">{dbStatus.error}</p>
                </div>
              )}

              <div className="border-border flex items-center justify-end border-t pt-4">
                <Button onClick={retestDb} disabled={loadingDb}>
                  <RefreshCw className="mr-2 h-4 w-4" />
                  重新测试
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  )
}
