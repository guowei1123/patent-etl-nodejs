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
  getBatchByCode,
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
  batchCode: string
  totalFiles: number
  totalPatents: number
  importedPatents: number
  error?: string
}

// 运行中的任务
const runningTasks = new Map<string, { cancel: () => void }>()

export function isTaskRunning(batchCode: string): boolean {
  return runningTasks.has(batchCode)
}

export function cancelTask(batchCode: string): boolean {
  const task = runningTasks.get(batchCode)
  if (task) {
    task.cancel()
    runningTasks.delete(batchCode)
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
  const tempSubdir = batchCode

  const report = (progress: ETLProgress) => {
    if (onProgress) onProgress(progress)
  }

  try {
    // 创建批次记录
    report({ stage: 'connecting', message: '创建批次记录...' })
    batch = await createBatch(batchCode, dataType, ftpFolder)

    // 设置取消函数
    runningTasks.set(batch.batch_code, {
      cancel: () => {
        cancelled = true
      },
    })

    await addLog(batch.batch_code, 'info', 'ETL任务启动', {
      ftpFolder,
      dataType,
    })

    // 连接 FTP
    report({ stage: 'connecting', message: '连接 FTP 服务器...' })
    await updateBatchStatus(batch.batch_code, 'downloading')

    ftpClient = createFtpClient(ftpConfig)
    await ftpClient.connect()

    await addLog(batch.batch_code, 'info', 'FTP连接成功')

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

    await updateBatchProgress(batch.batch_code, downloadedFiles.length)
    await addLog(
      batch.batch_code,
      'info',
      `下载完成: ${downloadedFiles.length} 个文件`,
    )

    if (cancelled) throw new Error('任务已取消')

    // 解压文件
    report({ stage: 'extracting', message: '正在解压文件...' })
    await updateBatchStatus(batch.batch_code, 'extracting')

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
        updateBatchProgress(batch!.batch_code, undefined, current)
      },
    )

    // 查找所有 XML 文件
    const xmlFiles = findXmlFiles(extractDir)
    const totalXmlFiles = xmlFiles.length

    await updateBatchProgress(
      batch.batch_code,
      undefined,
      downloadedFiles.length,
      totalXmlFiles,
    )
    await addLog(
      batch.batch_code,
      'info',
      `解压完成: ${totalXmlFiles} 个 XML 文件`,
    )

    if (cancelled) throw new Error('任务已取消')

    // 解析 XML
    report({ stage: 'parsing', message: '正在解析专利数据...' })
    await updateBatchStatus(batch.batch_code, 'parsing')

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

    await addLog(
      batch.batch_code,
      'info',
      `解析完成: ${patents.length} 条专利数据`,
    )

    if (cancelled) throw new Error('任务已取消')

    // 导入数据库
    report({ stage: 'importing', message: '正在导入数据库...' })
    await updateBatchStatus(batch.batch_code, 'importing')

    const BATCH_SIZE = 100
    let importedCount = 0

    for (let i = 0; i < patents.length; i += BATCH_SIZE) {
      if (cancelled) throw new Error('任务已取消')

      const batchPatents = patents.slice(i, i + BATCH_SIZE)
      const inserted = await insertPatents(batch.batch_code, batchPatents)
      importedCount += inserted

      await updateBatchProgress(
        batch.batch_code,
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

    await addLog(batch.batch_code, 'info', `导入完成: ${importedCount} 条记录`)

    // 完成
    await updateBatchStatus(batch.batch_code, 'completed')
    await updateBatchProgress(
      batch.batch_code,
      downloadedFiles.length,
      downloadedFiles.length,
      totalXmlFiles,
      importedCount,
    )

    report({ stage: 'completed', message: 'ETL任务完成!' })
    await addLog(batch.batch_code, 'info', 'ETL任务成功完成')

    // 清理临时文件
    cleanTempDir(tempSubdir)

    runningTasks.delete(batch.batch_code)

    return {
      success: true,
      batchCode: batch.batch_code,
      totalFiles: downloadedFiles.length,
      totalPatents: totalXmlFiles,
      importedPatents: importedCount,
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error'

    report({ stage: 'failed', message: `任务失败: ${errorMessage}` })

    if (batch) {
      await updateBatchStatus(batch.batch_code, 'failed', errorMessage)
      await addLog(batch.batch_code, 'error', errorMessage, {
        stack: error instanceof Error ? error.stack : undefined,
      })
      runningTasks.delete(batch.batch_code)
    }

    // 清理临时文件
    try {
      cleanTempDir(tempSubdir)
    } catch {
      // 忽略清理错误
    }

    return {
      success: false,
      batchCode: batch?.batch_code || '',
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

// 重试失败的批次
export async function retryBatch(batchCode: string): Promise<ETLResult> {
  const batch = await getBatchByCode(batchCode)

  if (!batch) {
    return {
      success: false,
      batchCode,
      totalFiles: 0,
      totalPatents: 0,
      importedPatents: 0,
      error: '批次不存在',
    }
  }

  if (batch.status !== 'failed') {
    return {
      success: false,
      batchCode,
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
