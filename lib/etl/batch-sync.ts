import * as fs from 'fs'
import * as path from 'path'
import { getTempPath, scanLocalArchiveFiles } from '../file-processor'
import { verifyDownloadedArchive } from '../integrity'
import {
  addLog,
  countImportedPatentsByBatch,
  getBatchByCode,
  getPool,
  updateBatchProgress,
} from '../db'
import type { ParsedPatent } from '@/types'
import { dedupePatentsForImport } from './import-step'

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
  let progressUpdate: {
    totalPatents: number
    importedPatents: number
    remainingPatents: number
  } | null = null

  if (!fs.existsSync(tempPath)) {
    newStatus = 'pending'
    details = '本地数据目录不存在，重置为待处理'
  } else if (fs.existsSync(parsedPath)) {
    const parsedPatents = JSON.parse(
      fs.readFileSync(parsedPath, 'utf-8'),
    ) as ParsedPatent[]
    const patents = dedupePatentsForImport(parsedPatents)
    const totalPatents = patents.length
    const importedPatents = await countImportedPatentsByBatch(batchCode)
    const remainingPatents = Math.max(totalPatents - importedPatents, 0)

    progressUpdate = { totalPatents, importedPatents, remainingPatents }
    await updateBatchProgress(
      batchCode,
      undefined,
      undefined,
      totalPatents,
      importedPatents,
    )

    if (totalPatents > 0 && importedPatents >= totalPatents) {
      newStatus = 'completed'
      details = `发现 parsed.json，数据库中已有 ${importedPatents}/${totalPatents} 条专利，标记为已完成`
    } else {
      newStatus = 'processed'
      details = `发现 parsed.json，已导入 ${importedPatents}/${totalPatents} 条，可继续导入`
    }
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
    const pool = await getPool()
    await pool.query(
      `UPDATE sync_batches
       SET status = $1::varchar,
           started_at = NULL,
           completed_at = CASE WHEN $1::varchar = 'completed' THEN CURRENT_TIMESTAMP ELSE NULL END,
           error_message = NULL
       WHERE batch_code = $2`,
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
        ...(progressUpdate ?? {}),
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
