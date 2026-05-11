import { FtpClient, createFtpClient } from './ftp-client'
import {
  getTempPath,
  cleanTempDir,
  extractFiles,
  findXmlFiles,
  isPatentXmlFile,
} from './file-processor'
import { parsePatentFiles } from './xml-parser'
import {
  createBatch,
  updateBatchStatus,
  updateBatchProgress,
  insertPatents,
  addLog,
  getBatchById,
} from './db'
import type { PatentType, ETLProgress, SyncBatch, FtpConfig } from '@/types'

export interface ETLOptions {
  batchCode: string
  dataType: PatentType
  ftpFolder: string
  ftpConfig?: Partial<FtpConfig>
  includeRawXml?: boolean
  onProgress?: (progress: ETLProgress) => void
}

export interface ETLResult {
  success: boolean
  batchId: number
  totalFiles: number
  totalPatents: number
  importedPatents: number
  error?: string
}

// 运行中的任务
const runningTasks = new Map<number, { cancel: () => void }>()

export function isTaskRunning(batchId: number): boolean {
  return runningTasks.has(batchId)
}

export function cancelTask(batchId: number): boolean {
  const task = runningTasks.get(batchId)
  if (task) {
    task.cancel()
    runningTasks.delete(batchId)
    return true
  }
  return false
}

export async function runETLPipeline(options: ETLOptions): Promise<ETLResult> {
  const {
    batchCode,
    dataType,
    ftpFolder,
    ftpConfig,
    includeRawXml = false,
    onProgress,
  } = options

  let batch: SyncBatch | null = null
  let ftpClient: FtpClient | null = null
  let cancelled = false
  const tempSubdir = `batch-${Date.now()}`

  const report = (progress: ETLProgress) => {
    if (onProgress) onProgress(progress)
  }

  try {
    // 创建批次记录
    report({ stage: 'connecting', message: '创建批次记录...' })
    batch = await createBatch(batchCode, dataType, ftpFolder)

    // 设置取消函数
    runningTasks.set(batch.id, {
      cancel: () => {
        cancelled = true
      },
    })

    await addLog(batch.id, 'info', 'ETL任务启动', { ftpFolder, dataType })

    // 连接 FTP
    report({ stage: 'connecting', message: '连接 FTP 服务器...' })
    await updateBatchStatus(batch.id, 'downloading')

    ftpClient = createFtpClient(ftpConfig)
    await ftpClient.connect()

    await addLog(batch.id, 'info', 'FTP连接成功')

    if (cancelled) throw new Error('任务已取消')

    // 下载文件
    report({ stage: 'downloading', message: '正在下载文件...' })
    const tempPath = getTempPath(tempSubdir)

    const downloadedFiles = await ftpClient.downloadDirectory(
      ftpFolder,
      tempPath,
      (entry) => {
        const ext = entry.name.toLowerCase()
        return (
          ext.endsWith('.zip') || ext.endsWith('.gz') || ext.endsWith('.xml')
        )
      },
      (fileName, index, total) => {
        report({
          stage: 'downloading',
          message: `下载文件: ${fileName}`,
          current: index,
          total,
          percentage: Math.round((index / total) * 100),
        })
      },
    )

    await updateBatchProgress(batch.id, downloadedFiles.length)
    await addLog(batch.id, 'info', `下载完成: ${downloadedFiles.length} 个文件`)

    if (cancelled) throw new Error('任务已取消')

    // 解压文件
    report({ stage: 'extracting', message: '正在解压文件...' })
    await updateBatchStatus(batch.id, 'extracting')

    const extractDir = getTempPath(`${tempSubdir}/extracted`)
    await extractFiles(
      downloadedFiles,
      extractDir,
      isPatentXmlFile,
      (current, total, fileName) => {
        report({
          stage: 'extracting',
          message: `解压文件: ${fileName}`,
          current,
          total,
          percentage: Math.round((current / total) * 100),
        })
        updateBatchProgress(batch!.id, undefined, current)
      },
    )

    // 查找所有 XML 文件
    const xmlFiles = findXmlFiles(extractDir)
    const totalXmlFiles = xmlFiles.length

    await updateBatchProgress(
      batch.id,
      undefined,
      downloadedFiles.length,
      totalXmlFiles,
    )
    await addLog(batch.id, 'info', `解压完成: ${totalXmlFiles} 个 XML 文件`)

    if (cancelled) throw new Error('任务已取消')

    // 解析 XML
    report({ stage: 'parsing', message: '正在解析专利数据...' })
    await updateBatchStatus(batch.id, 'parsing')

    const patents = await parsePatentFiles(
      xmlFiles,
      dataType,
      includeRawXml,
      (current, total, fileName) => {
        report({
          stage: 'parsing',
          message: `解析文件: ${fileName}`,
          current,
          total,
          percentage: Math.round((current / total) * 100),
        })
      },
    )

    await addLog(batch.id, 'info', `解析完成: ${patents.length} 条专利数据`)

    if (cancelled) throw new Error('任务已取消')

    // 导入数据库
    report({ stage: 'importing', message: '正在导入数据库...' })
    await updateBatchStatus(batch.id, 'importing')

    const BATCH_SIZE = 100
    let importedCount = 0

    for (let i = 0; i < patents.length; i += BATCH_SIZE) {
      if (cancelled) throw new Error('任务已取消')

      const batchPatents = patents.slice(i, i + BATCH_SIZE)
      const inserted = await insertPatents(batch.id, batchPatents)
      importedCount += inserted

      await updateBatchProgress(
        batch.id,
        undefined,
        undefined,
        undefined,
        importedCount,
      )

      report({
        stage: 'importing',
        message: `导入数据库: ${importedCount}/${patents.length}`,
        current: importedCount,
        total: patents.length,
        percentage: Math.round((importedCount / patents.length) * 100),
      })
    }

    await addLog(batch.id, 'info', `导入完成: ${importedCount} 条记录`)

    // 完成
    await updateBatchStatus(batch.id, 'completed')
    await updateBatchProgress(
      batch.id,
      downloadedFiles.length,
      downloadedFiles.length,
      totalXmlFiles,
      importedCount,
    )

    report({ stage: 'completed', message: 'ETL任务完成!' })
    await addLog(batch.id, 'info', 'ETL任务成功完成')

    // 清理临时文件
    cleanTempDir(tempSubdir)

    runningTasks.delete(batch.id)

    return {
      success: true,
      batchId: batch.id,
      totalFiles: downloadedFiles.length,
      totalPatents: totalXmlFiles,
      importedPatents: importedCount,
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error'

    report({ stage: 'failed', message: `任务失败: ${errorMessage}` })

    if (batch) {
      await updateBatchStatus(batch.id, 'failed', errorMessage)
      await addLog(batch.id, 'error', errorMessage, {
        stack: error instanceof Error ? error.stack : undefined,
      })
      runningTasks.delete(batch.id)
    }

    // 清理临时文件
    try {
      cleanTempDir(tempSubdir)
    } catch {
      // 忽略清理错误
    }

    return {
      success: false,
      batchId: batch?.id || 0,
      totalFiles: 0,
      totalPatents: 0,
      importedPatents: 0,
      error: errorMessage,
    }
  } finally {
    // 断开 FTP 连接
    if (ftpClient) {
      try {
        await ftpClient.disconnect()
      } catch {
        // 忽略断开连接错误
      }
    }
  }
}

// 获取批次当前状态
export async function getBatchStatus(batchId: number): Promise<{
  batch: SyncBatch | null
  isRunning: boolean
}> {
  const batch = await getBatchById(batchId)
  return {
    batch,
    isRunning: isTaskRunning(batchId),
  }
}

// 重试失败的批次
export async function retryBatch(batchId: number): Promise<ETLResult> {
  const batch = await getBatchById(batchId)

  if (!batch) {
    return {
      success: false,
      batchId,
      totalFiles: 0,
      totalPatents: 0,
      importedPatents: 0,
      error: '批次不存在',
    }
  }

  if (batch.status !== 'failed') {
    return {
      success: false,
      batchId,
      totalFiles: 0,
      totalPatents: 0,
      importedPatents: 0,
      error: '只能重试失败的批次',
    }
  }

  // 重新运行 ETL
  return runETLPipeline({
    batchCode: `${batch.batch_code}-retry-${Date.now()}`,
    dataType: batch.data_type,
    ftpFolder: batch.ftp_folder || '',
  })
}
