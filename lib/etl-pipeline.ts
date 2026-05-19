import * as fs from 'fs'
import * as path from 'path'
import {
  FtpClient,
  createFtpClient,
  createFtpPool,
  FtpConnectionPool,
} from './ftp-client'
import {
  getTempPath,
  cleanTempDir,
  extractFiles,
  forEachZipEntry,
  isPatentXmlFile,
  scanLocalArchiveFiles,
  withPreparedArchiveFiles,
} from './file-processor'
import { parsePatentXml } from './xml-parser'
import {
  verifyDownloadedArchive,
  verifyExtractedFilesCrc,
  formatIntegrityReport,
  openZipForVerify,
} from './integrity'
import {
  updateBatchStatus,
  updateBatchProgress,
  insertPatents,
  addLog,
  getBatchByCode,
  getPool,
} from './db'
import type {
  PatentType,
  SyncBatch,
  FileDownloadProgress,
  FileDownloadItem,
  ParsedPatent,
} from '@/types'

export interface StepResult {
  success: boolean
  batchCode: string
  error?: string
  details?: Record<string, unknown>
}

// 运行中的任务
const runningTasks = new Map<
  string,
  { cancel: () => void; cancelling: boolean }
>()

// 当前下载文件的字节级进度（内存中，进程重启后丢失）
const downloadProgress = new Map<string, FileDownloadProgress>()

// 文件列表下载状态
const downloadFileList = new Map<string, FileDownloadItem[]>()

// 速度追踪（滑动窗口）
interface SpeedTracker {
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
const speedTrackers = new Map<string, SpeedTracker>()

function computeSpeed(batchCode: string): number {
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

// 获取批次当前状态
export async function getBatchStatus(batchCode: string): Promise<{
  batch: SyncBatch | null
  isRunning: boolean
}> {
  const batch = await getBatchByCode(batchCode)
  return {
    batch,
    isRunning: isTaskRunning(batchCode),
  }
}

// ============ 独立步骤函数 ============

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
    await updateBatchProgress(
      batchCode,
      fileEntries.length,
      batch.processed_files,
    )

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
    const fileList: FileDownloadItem[] = filteredEntries.map((e) => ({
      fileName: e.name,
      fileSize: e.size,
      status: 'pending' as const,
      bytesDownloaded: 0,
    }))
    downloadFileList.set(batchCode, fileList)

    // O(1) 文件名查找
    const fileListMap = new Map(fileList.map((f) => [f.fileName, f]))

    // 列表完毕后关闭单连接，改用连接池并行下载
    ftpClient.disconnect()
    ftpClient = null

    pool = createFtpPool()
    await pool.connect()
    await addLog(batchCode, 'info', `FTP 连接池已建立，并发下载已启用`)

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

// 步骤 2：流式处理（外层解压 + CRC 校验 + 流式解析 XML）
export async function runProcessStep(batchCode: string): Promise<StepResult> {
  const batch = await getBatchByCode(batchCode)
  if (!batch) return { success: false, batchCode, error: '批次不存在' }
  if (batch.status !== 'downloaded') {
    return {
      success: false,
      batchCode,
      error: `当前状态 ${batch.status} 不可执行处理，需要 downloaded`,
    }
  }

  let cancelled = false
  runningTasks.set(batchCode, {
    cancel: () => {
      cancelled = true
    },
    cancelling: false,
  })

  try {
    await updateBatchStatus(batchCode, 'processing')
    await addLog(batchCode, 'info', '开始处理步骤')

    const tempPath = getTempPath(batchCode)
    const extractDir = getTempPath(`${batchCode}/extracted`)

    // === 阶段 1：外层解压（内层 ZIP 仍写磁盘，用于 CRC 校验） ===

    let innerZips = fs.existsSync(extractDir)
      ? fs
          .readdirSync(extractDir)
          .filter((f) => f.toUpperCase().endsWith('.ZIP'))
      : []

    // 跳过解压前验证已有内层 ZIP 的结构完整性
    if (innerZips.length > 0) {
      let allValid = true
      for (const f of innerZips) {
        try {
          await openZipForVerify(path.join(extractDir, f))
        } catch {
          allValid = false
          break
        }
      }
      if (!allValid) {
        await addLog(
          batchCode,
          'warn',
          '已解压文件中存在损坏的 ZIP，将重新解压',
        )
        fs.rmSync(extractDir, { recursive: true, force: true })
        fs.mkdirSync(extractDir, { recursive: true })
        innerZips = []
      }
    }

    if (innerZips.length === 0) {
      await withPreparedArchiveFiles(
        tempPath,
        async (filesToExtract) => {
          await addLog(
            batchCode,
            'info',
            `解压外层压缩包: ${filesToExtract.length} 个文件`,
          )

          await extractFiles(
            filesToExtract,
            extractDir,
            undefined,
            (current) => {
              updateBatchProgress(batchCode, undefined, current)
            },
          )
        },
        {
          beforeMerge: async (group) => {
            await addLog(
              batchCode,
              'info',
              `合并分卷 ZIP: ${group.baseName} (${group.splitParts.length + 1} 个文件)`,
            )
          },
        },
      )

      innerZips = fs
        .readdirSync(extractDir)
        .filter((f) => f.toUpperCase().endsWith('.ZIP'))
    }

    if (cancelled) throw new Error('任务已取消')

    // === 阶段 2：CRC 校验（验证内层 ZIP 完整性） ===

    await runCrcCheck(batchCode, extractDir)

    if (innerZips.length === 0) {
      throw new Error('未找到内层 ZIP 文件')
    }

    // === 阶段 3：流式解析 XML（不写磁盘） ===

    await addLog(batchCode, 'info', `流式解析 ${innerZips.length} 个内层 ZIP`)

    const patents: ParsedPatent[] = []
    const patentType = batch.data_type as PatentType

    for (let i = 0; i < innerZips.length; i++) {
      if (cancelled) throw new Error('任务已取消')

      const zipFile = path.join(extractDir, innerZips[i])
      const result = await forEachZipEntry(
        zipFile,
        (fileName, content) => {
          const patent = parsePatentXml(content, patentType)
          if (patent) {
            patent.source_file = fileName
            patents.push(patent)
          }
        },
        isPatentXmlFile,
      )

      await addLog(
        batchCode,
        'info',
        `${innerZips[i]}: ${result.processed} 个 XML 解析, ${patents.length} 条累计专利`,
      )
      updateBatchProgress(batchCode, undefined, i + 1)
    }

    if (patents.length === 0) {
      throw new Error('未解析到任何专利数据')
    }

    // 将解析结果写入中间文件，供导入步骤使用
    // 清除冗余的 description（与 description_structured 内容重复），避免 parsed.json 超过 V8 字符串上限
    for (const p of patents) {
      if (p.description_structured) {
        p.description = undefined
      }
    }
    const parsedPath = path.join(tempPath, 'parsed.json')
    fs.writeFileSync(parsedPath, JSON.stringify(patents))

    await updateBatchProgress(batchCode, undefined, undefined, patents.length)
    await updateBatchStatus(batchCode, 'processed')
    await addLog(batchCode, 'info', `处理完成: ${patents.length} 条专利数据`)

    return {
      success: true,
      batchCode,
      details: { totalPatents: patents.length, innerZips: innerZips.length },
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error'
    await updateBatchStatus(batchCode, 'failed', errorMessage)
    await addLog(batchCode, 'error', `处理失败: ${errorMessage}`)
    return { success: false, batchCode, error: errorMessage }
  } finally {
    runningTasks.delete(batchCode)
  }
}

// 步骤 3：导入数据库
export async function runImportStep(batchCode: string): Promise<StepResult> {
  const batch = await getBatchByCode(batchCode)
  if (!batch) return { success: false, batchCode, error: '批次不存在' }
  if (batch.status !== 'processed') {
    return {
      success: false,
      batchCode,
      error: `当前状态 ${batch.status} 不可执行导入，需要 processed`,
    }
  }

  let cancelled = false
  runningTasks.set(batchCode, {
    cancel: () => {
      cancelled = true
    },
    cancelling: false,
  })

  try {
    await updateBatchStatus(batchCode, 'importing')
    await addLog(batchCode, 'info', '开始导入步骤')

    const parsedPath = path.join(getTempPath(batchCode), 'parsed.json')
    if (!fs.existsSync(parsedPath)) {
      throw new Error('parsed.json 不存在，请先执行处理步骤')
    }

    const patents = JSON.parse(fs.readFileSync(parsedPath, 'utf-8'))

    const BATCH_SIZE = 100
    let importedCount = 0

    for (let i = 0; i < patents.length; i += BATCH_SIZE) {
      if (cancelled) throw new Error('任务已取消')

      const batchPatents = patents.slice(i, i + BATCH_SIZE)
      const inserted = await insertPatents(batchCode, batchPatents)
      importedCount += inserted

      await updateBatchProgress(
        batchCode,
        undefined,
        undefined,
        undefined,
        importedCount,
      )
    }

    await addLog(batchCode, 'info', `导入完成: ${importedCount} 条记录`)

    if (importedCount === 0) {
      throw new Error('所有专利均导入失败')
    }

    await updateBatchStatus(batchCode, 'completed')
    await updateBatchProgress(
      batchCode,
      undefined,
      undefined,
      patents.length,
      importedCount,
    )

    // 清理临时文件
    cleanTempDir(batchCode)

    await addLog(batchCode, 'info', 'ETL 任务全部完成')

    return {
      success: true,
      batchCode,
      details: { importedPatents: importedCount },
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error'
    await updateBatchStatus(batchCode, 'failed', errorMessage)
    await addLog(batchCode, 'error', `导入失败: ${errorMessage}`)
    return { success: false, batchCode, error: errorMessage }
  } finally {
    runningTasks.delete(batchCode)
  }
}

// 完整性检测辅助函数
async function runCrcCheck(
  batchCode: string,
  extractDir: string,
): Promise<void> {
  const extractCheck = await verifyExtractedFilesCrc(extractDir)
  await addLog(
    batchCode,
    extractCheck.passed ? 'info' : 'error',
    extractCheck.passed
      ? `CRC 完整性检测通过: ${extractCheck.checkedFiles} 个文件`
      : `CRC 完整性检测失败: ${extractCheck.failures.length} 个问题`,
    extractCheck.passed ? undefined : { failures: extractCheck.failures },
  )
  if (!extractCheck.passed) {
    throw new Error(
      `CRC 完整性检测失败:\n${formatIntegrityReport(extractCheck)}`,
    )
  }
}

// 步骤函数映射
export const stepFunctions: Record<
  string,
  (batchCode: string) => Promise<StepResult>
> = {
  download: runDownloadStep,
  process: runProcessStep,
  import: runImportStep,
}

// 同步批次记录：根据本地文件系统状态修正数据库记录
export async function syncBatchRecord(batchCode: string): Promise<{
  success: boolean
  batchCode: string
  previousStatus: string
  newStatus: string
  details: string
}> {
  const batch = await getBatchByCode(batchCode)

  if (!batch) {
    return {
      success: false,
      batchCode,
      previousStatus: '',
      newStatus: '',
      details: '批次记录不存在',
    }
  }

  const previousStatus = batch.status

  if (previousStatus === 'completed') {
    return {
      success: false,
      batchCode,
      previousStatus,
      newStatus: previousStatus,
      details: '已完成的批次无需同步',
    }
  }

  const tempPath = getTempPath(batchCode)
  const extractDir = path.join(tempPath, 'extracted')
  const parsedPath = path.join(tempPath, 'parsed.json')

  let newStatus: string = previousStatus
  let details = ''

  if (!fs.existsSync(tempPath)) {
    newStatus = 'pending'
    details = '本地数据目录不存在，重置为待处理'
  } else if (fs.existsSync(parsedPath)) {
    newStatus = 'processed'
    details = '发现 parsed.json，可执行导入步骤'
  } else if (fs.existsSync(extractDir)) {
    const innerZips = fs
      .readdirSync(extractDir)
      .filter((f) => f.toUpperCase().endsWith('.ZIP'))
    if (innerZips.length > 0) {
      newStatus = 'downloaded'
      details = `外层已解压，发现 ${innerZips.length} 个内层 ZIP 待处理`
    } else {
      newStatus = 'downloaded'
      details = 'extracted/ 目录无内层 ZIP，将重新解压'
    }
  } else {
    const rootFiles = scanLocalArchiveFiles(tempPath)
    const allLocalFiles = fs
      .readdirSync(tempPath)
      .filter((f) => fs.statSync(path.join(tempPath, f)).isFile())
    if (rootFiles.length > 0 || allLocalFiles.length > 0) {
      const check = await verifyDownloadedArchive(tempPath)
      if (check.passed) {
        newStatus = 'downloaded'
        details = `发现 ${rootFiles.length} 个本地文件（完整性验证通过），待处理`
      } else {
        newStatus = 'pending'
        await updateBatchProgress(batchCode, undefined, allLocalFiles.length)
        details = `发现 ${allLocalFiles.length} 个本地文件（部分下载），将续传缺失文件`
      }
    } else {
      newStatus = 'pending'
      details = '本地目录为空，需重新下载'
    }
  }

  if (newStatus !== previousStatus) {
    const pool = getPool()
    await pool.query(
      `UPDATE sync_batches SET status = $1, started_at = NULL, completed_at = NULL, error_message = NULL WHERE batch_code = $2`,
      [newStatus, batchCode],
    )

    await addLog(
      batchCode,
      'info',
      `批次记录同步: ${previousStatus} -> ${newStatus}`,
      {
        previousStatus,
        newStatus,
        details,
      },
    )
  }

  return {
    success: newStatus !== previousStatus,
    batchCode,
    previousStatus,
    newStatus,
    details,
  }
}
