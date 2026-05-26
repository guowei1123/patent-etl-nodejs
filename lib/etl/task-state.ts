import type { FileDownloadItem, FileDownloadProgress } from '@/types'

export interface SpeedTracker {
  samples: Array<{ timestamp: number; bytes: number }>
  windowMs: number
  maxSamples: number
  filesCompleted: number
  totalFilesInBatch: number
  batchBytesDone: number
  lastFileBytes: Map<string, number>
  aggregateBytes: number
  lastUpdateTs?: number
}

export const runningTasks = new Map<
  string,
  { cancel: () => void; cancelling: boolean }
>()

export const downloadProgress = new Map<string, FileDownloadProgress>()

export const downloadFileList = new Map<string, FileDownloadItem[]>()

export const speedTrackers = new Map<string, SpeedTracker>()

export function computeSpeed(batchCode: string): number {
  const tracker = speedTrackers.get(batchCode)
  if (!tracker || tracker.samples.length < 2) return 0

  const cutoff = Date.now() - tracker.windowMs
  while (tracker.samples.length > 1 && tracker.samples[0].timestamp < cutoff) {
    tracker.samples.shift()
  }
  if (tracker.samples.length < 2) return 0

  const oldest = tracker.samples[0]
  const newest = tracker.samples[tracker.samples.length - 1]
  const elapsedSec = (newest.timestamp - oldest.timestamp) / 1000
  if (elapsedSec < 0.5) return 0
  return (newest.bytes - oldest.bytes) / elapsedSec
}

export function getDownloadProgress(
  batchCode: string,
): FileDownloadProgress | null {
  return downloadProgress.get(batchCode) ?? null
}

export function getDownloadFileList(
  batchCode: string,
): FileDownloadItem[] | null {
  return downloadFileList.get(batchCode) ?? null
}

export function isTaskRunning(batchCode: string): boolean {
  return runningTasks.has(batchCode)
}

export function isTaskCancelling(batchCode: string): boolean {
  return runningTasks.get(batchCode)?.cancelling ?? false
}

export function cancelTask(batchCode: string): boolean {
  const task = runningTasks.get(batchCode)
  if (task) {
    task.cancelling = true
    task.cancel()
    return true
  }
  return false
}
