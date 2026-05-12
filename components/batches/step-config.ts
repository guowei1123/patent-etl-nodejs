import { Download, FileSearch, Database } from 'lucide-react'
import type { BatchStatus, SyncBatch } from '@/types'

export const stepConfig = [
  {
    key: 'download',
    label: '下载',
    icon: Download,
    doneStatus: 'downloaded' as BatchStatus,
    runningStatus: 'downloading' as BatchStatus,
  },
  {
    key: 'process',
    label: '处理',
    icon: FileSearch,
    doneStatus: 'processed' as BatchStatus,
    runningStatus: 'processing' as BatchStatus,
  },
  {
    key: 'import',
    label: '导入',
    icon: Database,
    doneStatus: 'completed' as BatchStatus,
    runningStatus: 'importing' as BatchStatus,
  },
]

export function getProgress(batch: SyncBatch): number {
  if (batch.status === 'completed') return 100
  if (batch.status === 'pending' || batch.status === 'failed') return 0

  const progressMap: Record<string, number> = {
    downloading: 0,
    downloaded: 33,
    processing: 33,
    processed: 66,
    importing: 66,
  }

  const baseProgress = progressMap[batch.status]
  if (baseProgress === undefined) return 0

  const isRunning = ['downloading', 'processing', 'importing'].includes(
    batch.status,
  )
  if (!isRunning) return baseProgress

  if (batch.total_files > 0 || batch.total_patents > 0) {
    const stageProgress =
      batch.status === 'importing' && batch.total_patents > 0
        ? (batch.imported_patents / batch.total_patents) * 25
        : batch.total_files > 0
          ? (batch.processed_files / batch.total_files) * 25
          : 0
    return Math.min(baseProgress + stageProgress, 99)
  }

  return baseProgress
}
