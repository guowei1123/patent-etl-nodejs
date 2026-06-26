'use client'

import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { Spinner } from '@/components/ui/spinner'
import {
  Folder,
  File,
  ChevronRight,
  ChevronUp,
  AlertCircle,
  Check,
  RefreshCw,
} from 'lucide-react'
import type { FtpEntry } from '@/types'
import { cn } from '@/lib/utils'

interface FtpBrowserProps {
  onSelect: (path: string) => void
  initialPath?: string
}

export function FtpBrowser({ onSelect, initialPath = '/' }: FtpBrowserProps) {
  const [currentPath, setCurrentPath] = useState(initialPath)
  const [entries, setEntries] = useState<FtpEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [cacheInfo, setCacheInfo] = useState<{
    cached: boolean
    cachedAt: number
  } | null>(null)

  const loadDirectory = async (path: string, refresh = false) => {
    setLoading(true)
    setError(null)

    try {
      const response = await fetch(
        `/api/ftp/browse?path=${encodeURIComponent(path)}${
          refresh ? '&refresh=true' : ''
        }`,
      )
      const result = await response.json()

      if (result.success) {
        setEntries(result.data.entries)
        setCurrentPath(path)
        setCacheInfo({
          cached: Boolean(result.data.cached),
          cachedAt: result.data.cachedAt,
        })
      } else {
        setError(result.error || '加载失败')
      }
    } catch {
      setError('无法连接到 FTP 服务器')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let cancelled = false

    async function loadInitialDirectory() {
      try {
        const response = await fetch(
          `/api/ftp/browse?path=${encodeURIComponent(initialPath)}`,
        )
        const result = await response.json()

        if (cancelled) return

        if (result.success) {
          setEntries(result.data.entries)
          setCurrentPath(initialPath)
          setSelectedPath(null)
          setCacheInfo({
            cached: Boolean(result.data.cached),
            cachedAt: result.data.cachedAt,
          })
        } else {
          setError(result.error || '加载失败')
        }
      } catch {
        if (!cancelled) {
          setError('无法连接到 FTP 服务器')
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    void loadInitialDirectory()

    return () => {
      cancelled = true
    }
  }, [initialPath])

  const navigateUp = () => {
    if (currentPath === '/') return
    const parentPath = currentPath.split('/').slice(0, -1).join('/') || '/'
    loadDirectory(parentPath)
  }

  const navigateTo = (entry: FtpEntry) => {
    if (entry.type === 'directory') {
      loadDirectory(entry.path)
    }
  }

  const handleSelect = () => {
    if (selectedPath) {
      onSelect(selectedPath)
    }
  }

  const formatCacheTime = (timestamp?: number) => {
    if (!timestamp) return ''
    return new Date(timestamp).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  const formatSize = (bytes: number) => {
    if (bytes === 0) return '-'
    const units = ['B', 'KB', 'MB', 'GB']
    let unitIndex = 0
    let size = bytes
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024
      unitIndex++
    }
    return `${size.toFixed(1)} ${units[unitIndex]}`
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Path Bar */}
      <div className="bg-secondary/50 flex items-center gap-2 rounded-lg px-3 py-2">
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-6"
          onClick={navigateUp}
          disabled={currentPath === '/' || loading}
          aria-label="返回上级目录"
        >
          <ChevronUp aria-hidden="true" />
        </Button>
        <code className="text-muted-foreground flex-1 text-sm">
          {currentPath}
        </code>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-6"
          onClick={() => loadDirectory(currentPath, true)}
          disabled={loading}
          aria-label="刷新缓存"
        >
          <RefreshCw
            className={cn(loading && 'animate-spin')}
            aria-hidden="true"
          />
        </Button>
      </div>
      {cacheInfo?.cachedAt && (
        <p className="text-muted-foreground text-xs">
          {cacheInfo.cached ? '已使用缓存' : '已刷新远程数据'} ·{' '}
          {formatCacheTime(cacheInfo.cachedAt)}
        </p>
      )}

      {/* Content */}
      <ScrollArea className="border-border h-[300px] rounded-lg border">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Spinner className="text-muted-foreground size-6" />
          </div>
        ) : error ? (
          <div className="p-4">
            <Alert variant="destructive">
              <AlertCircle aria-hidden="true" />
              <AlertTitle>无法加载 FTP 目录</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
            <Button
              variant="outline"
              size="sm"
              className="mt-4"
              onClick={() => loadDirectory(currentPath)}
            >
              重试
            </Button>
          </div>
        ) : entries.length === 0 ? (
          <Empty className="border-0 py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Folder aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>空文件夹</EmptyTitle>
              <EmptyDescription>当前目录没有可选择的文件夹。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="p-2">
            {entries.map((entry) => (
              <button
                key={entry.path}
                type="button"
                className={cn(
                  'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors',
                  selectedPath === entry.path
                    ? 'bg-accent text-accent-foreground'
                    : 'hover:bg-secondary/50',
                )}
                onClick={() => {
                  if (entry.type === 'directory') {
                    setSelectedPath(entry.path)
                  }
                }}
                onDoubleClick={() => navigateTo(entry)}
              >
                {entry.type === 'directory' ? (
                  <Folder className="text-accent size-4" aria-hidden="true" />
                ) : (
                  <File
                    className="text-muted-foreground size-4"
                    aria-hidden="true"
                  />
                )}
                <span className="flex-1 truncate text-sm">{entry.name}</span>
                <span className="text-muted-foreground text-xs">
                  {formatSize(entry.size)}
                </span>
                {entry.type === 'directory' && (
                  <ChevronRight
                    className="text-muted-foreground size-4"
                    aria-hidden="true"
                  />
                )}
                {selectedPath === entry.path && (
                  <Check className="text-accent size-4" aria-hidden="true" />
                )}
              </button>
            ))}
          </div>
        )}
      </ScrollArea>

      {/* Actions */}
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-xs">
          {selectedPath
            ? `已选择: ${selectedPath}`
            : '双击进入文件夹，单击选择'}
        </p>
        <Button onClick={handleSelect} disabled={!selectedPath}>
          确定选择
        </Button>
      </div>
    </div>
  )
}
