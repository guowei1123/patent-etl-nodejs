import * as fs from 'fs'
import * as path from 'path'
import {
  FtpClient,
  createFtpClient,
  createFtpPool,
  FtpConnectionPool,
} from '../ftp-client'
import { getTempPath } from '../file-processor'
import { verifyDownloadedArchive, formatIntegrityReport } from '../integrity'
import {
  updateBatchStatus,
  updateBatchProgress,
  addLog,
  getBatchByCode,
} from '../db'
import type { FileDownloadItem } from '@/types'
import type { StepResult } from './types'
import {
  computeSpeed,
  downloadFileList,
  downloadProgress,
  runningTasks,
  speedTrackers,
} from './task-state'

// 步骤 1：从 FTP 下载数据
export async function runDownloadStep(batchCode: string): Promise<StepResult> {
  const batch = await getBatchByCode(batchCode)
  if (!batch) return { success: false, batchCode, error: '批次不存在' }
  if (batch.status !== 'pending') {
    return {
      success: false,
      batchCode,
      error: `当前状态 ${batch.status} 不可执行下载，需要 pending`,
    }
  }

  if (!batch.ftp_folder) {
    return {
      success: false,
      batchCode,
      error: '批次未设置 FTP 文件夹路径，无法执行下载',
    }
  }

  let cancelled = false
  let ftpClient: FtpClient | null = null
  let pool: FtpConnectionPool | null = null
  runningTasks.set(batchCode, {
    cancel: () => {
      cancelled = true
    },
    cancelling: false,
  })

  try {
    await updateBatchStatus(batchCode, 'downloading')
    await addLog(batchCode, 'info', '开始下载步骤')

    ftpClient = createFtpClient()
    await ftpClient.connect()
    await addLog(batchCode, 'info', 'FTP 连接成功')

    if (cancelled) throw new Error('任务已取消')

    const tempPath = getTempPath(batchCode)
    const ftpFolder = batch.ftp_folder

    // 获取文件列表以设置 total_files
    const allEntries = await ftpClient.listDirectory(ftpFolder)
    const fileEntries = allEntries.filter((e) => e.type === 'file')

    // 文件名过滤器
    const fileFilter = (entry: { name: string }) => {
      const name = entry.name.toLowerCase()
      if (
        name.endsWith('.zip') ||
        name.endsWith('.gz') ||
        name.endsWith('.xml')
      )
        return true
      const dotIdx = name.lastIndexOf('.')
      if (dotIdx >= 0) {
        const ext = name.substring(dotIdx)
        if (/^\.z\d+$/.test(ext)) return true
      }
      return false
    }

    // 初始化文件列表状态
    const filteredEntries = fileEntries.filter(fileFilter)
    await updateBatchProgress(batchCode, filteredEntries.length)

    const fileList: FileDownloadItem[] = filteredEntries.map((e) => {
      const localPath = path.join(tempPath, e.name)
      let localSize = 0
      try {
        if (fs.existsSync(localPath)) {
          localSize = fs.statSync(localPath).size
        }
      } catch {
        localSize = 0
      }

      const bytesDownloaded =
        e.size > 0 ? Math.min(Math.max(localSize, 0), e.size) : 0
      const status =
        e.size > 0 && localSize === e.size
          ? ('skipped' as const)
          : bytesDownloaded > 0
            ? ('partial' as const)
            : ('pending' as const)

      return {
        fileName: e.name,
        fileSize: e.size,
        status,
        bytesDownloaded,
      }
    })
    downloadFileList.set(batchCode, fileList)

    // O(1) 文件名查找
    const fileListMap = new Map(fileList.map((f) => [f.fileName, f]))

    // 列表完毕后关闭单连接，改用连接池并行下载
    ftpClient.disconnect()
    ftpClient = null

    pool = createFtpPool()
    await pool.connect()
    const totalBytes = filteredEntries.reduce((sum, e) => sum + e.size, 0)
    const retryAttempts = Math.max(
      1,
      parseInt(process.env.FTP_RETRY_ATTEMPTS || '3'),
    )
    const retryDelayMs = Math.max(
      0,
      parseInt(process.env.FTP_RETRY_DELAY_MS || '3000'),
    )
    await addLog(
      batchCode,
      'info',
      `FTP 连接池已建立，并发下载已启用: ${pool.getConcurrency()} 个连接, 超时 ${pool.getTimeout()}ms, 重试 ${retryAttempts} 次, 重试间隔 ${retryDelayMs}ms, 文件 ${filteredEntries.length} 个, 总大小 ${totalBytes} bytes`,
    )

    const downloadResult = await pool.downloadFiles(filteredEntries, tempPath, {
      cancelled: () => cancelled,
      onFileDownloaded: (
        fileName: string,
        index: number,
        _total: number,
        skipped: boolean,
      ) => {
        const tracker = speedTrackers.get(batchCode)
        if (tracker) {
          const item = fileListMap.get(fileName)
          const prevBytes = tracker.lastFileBytes.get(fileName) ?? 0
          const finalBytes = item?.fileSize ?? 0
          tracker.aggregateBytes += Math.max(finalBytes - prevBytes, 0)
          tracker.samples.push({
            timestamp: Date.now(),
            bytes: tracker.aggregateBytes,
          })
          if (tracker.samples.length > tracker.maxSamples) {
            tracker.samples.shift()
          }
          tracker.filesCompleted = index
          tracker.batchBytesDone += item?.fileSize ?? 0
          tracker.lastFileBytes.delete(fileName)
        }
        downloadProgress.delete(batchCode)

        const item = fileListMap.get(fileName)
        if (item) {
          item.status = skipped ? 'skipped' : 'completed'
          item.bytesDownloaded = item.fileSize
        }

        updateBatchProgress(batchCode, undefined, index)
      },
      onFileProgress: (fileName: string, bytes: number, total: number) => {
        // 轻量操作：更新当前文件的字节进度（每次都执行）
        const item = fileListMap.get(fileName)
        if (item) {
          item.status = 'downloading'
          item.bytesDownloaded = bytes
        }

        let t = speedTrackers.get(batchCode)
        if (!t) {
          const now = Date.now()
          t = {
            samples: [],
            windowMs: 30000,
            maxSamples: 10,
            filesCompleted: batch.processed_files,
            totalFilesInBatch: filteredEntries.length,
            batchBytesDone: 0,
            lastFileBytes: new Map(),
            aggregateBytes: 0,
            lastUpdateTs: now,
          }
          speedTrackers.set(batchCode, t)
        }

        // 先记录每个文件的增量字节，避免节流导致并发下载丢样本。
        const prev = t.lastFileBytes.get(fileName) ?? 0
        const delta = bytes - prev
        t.lastFileBytes.set(fileName, bytes)
        t.aggregateBytes += Math.max(delta, 0)

        // 重量操作：节流为最多每秒执行一次
        const now = Date.now()
        if (now - (t.lastUpdateTs ?? 0) < 1000) return
        t.lastUpdateTs = now

        t.samples.push({ timestamp: now, bytes: t.aggregateBytes })
        if (t.samples.length > t.maxSamples) {
          t.samples.shift()
        }

        const speed = computeSpeed(batchCode)
        const remaining = Math.max(total - bytes, 0)
        const fileEta = speed > 0 && total > 0 ? remaining / speed : null

        const filesRemaining = t.totalFilesInBatch - t.filesCompleted - 1
        const avgFileSize =
          t.filesCompleted > 0 ? t.batchBytesDone / t.filesCompleted : total
        const batchRemaining = remaining + filesRemaining * avgFileSize
        const batchEta =
          speed > 0 && batchRemaining > 0 ? batchRemaining / speed : null

        downloadProgress.set(batchCode, {
          fileName,
          bytesDownloaded: bytes,
          totalBytes: total,
          speedBytesPerSec: speed,
          fileEtaSeconds: fileEta,
          batchEtaSeconds: batchEta,
        })
      },
      onFileRetry: (
        fileName,
        attempt,
        maxAttempts,
        error,
        localBytes,
        remoteBytes,
      ) => {
        const item = fileListMap.get(fileName)
        if (item) {
          item.status = localBytes > 0 ? 'partial' : 'pending'
          item.bytesDownloaded =
            remoteBytes > 0 ? Math.min(localBytes, remoteBytes) : localBytes
        }

        void addLog(
          batchCode,
          'warn',
          `下载重试 ${attempt}/${maxAttempts}: ${fileName}`,
          {
            error,
            localBytes,
            remoteBytes,
          },
        )
      },
      resume: true,
    })

    if (cancelled) throw new Error('任务已取消')

    downloadProgress.delete(batchCode)
    downloadFileList.delete(batchCode)
    await updateBatchProgress(
      batchCode,
      undefined,
      downloadResult.totalProcessed,
    )
    const downloadCheck = await verifyDownloadedArchive(tempPath)
    await addLog(
      batchCode,
      downloadCheck.passed ? 'info' : 'error',
      downloadCheck.passed
        ? `下载完整性检测通过: ${downloadCheck.checkedFiles} 个文件`
        : `下载完整性检测失败: ${downloadCheck.failures.length} 个问题`,
      downloadCheck.passed ? undefined : { failures: downloadCheck.failures },
    )
    if (!downloadCheck.passed) {
      throw new Error(
        `下载完整性检测失败:\n${formatIntegrityReport(downloadCheck)}`,
      )
    }

    await updateBatchStatus(batchCode, 'downloaded')
    await addLog(
      batchCode,
      'info',
      `下载完成: ${downloadResult.downloadedPaths.length} 个文件下载, ${downloadResult.skippedCount} 个已存在`,
    )

    return {
      success: true,
      batchCode,
      details: { totalFiles: downloadResult.totalProcessed },
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error'
    downloadProgress.delete(batchCode)
    speedTrackers.delete(batchCode)
    downloadFileList.delete(batchCode)
    await updateBatchStatus(batchCode, 'failed', errorMessage)
    await addLog(batchCode, 'error', `下载失败: ${errorMessage}`)
    return { success: false, batchCode, error: errorMessage }
  } finally {
    runningTasks.delete(batchCode)
    downloadProgress.delete(batchCode)
    speedTrackers.delete(batchCode)
    downloadFileList.delete(batchCode)
    if (ftpClient) {
      try {
        await ftpClient.disconnect()
      } catch {}
    }
    if (pool) {
      try {
        pool.disconnect()
      } catch {}
    }
  }
}
