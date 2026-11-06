import * as fs from 'fs'
import * as path from 'path'
import { getTempPath } from '../file-processor'
import {
  addLog,
  countImportedPatentsByBatch,
  getBatchByCode,
  getImportedPatentKeysByBatch,
  insertPatents,
  updateBatchProgress,
  updateBatchStatus,
} from '../db'
import type {
  ParsedPatent,
  PatentImportFailure,
  PatentImportResult,
} from '@/types'
import type { StepResult } from './types'
import { runningTasks } from './task-state'
import {
  getPatentImportKey,
  indexParsedPatentFile,
  readPatentImportGroups,
} from './parsed-patent-file'
export { getPatentImportKey } from './parsed-patent-file'

export function filterRemainingPatentsForImport(
  patents: ParsedPatent[],
  importedKeys: Set<string>,
): ParsedPatent[] {
  return patents.filter(
    (patent) => !importedKeys.has(getPatentImportKey(patent)),
  )
}

export function dedupePatentsForImport(
  patents: ParsedPatent[],
): ParsedPatent[] {
  const uniquePatents = new Map<string, ParsedPatent>()

  for (const patent of patents) {
    uniquePatents.set(getPatentImportKey(patent), patent)
  }

  return Array.from(uniquePatents.values())
}

function formatImportFailureMessage(
  importedCount: number,
  totalPatents: number,
  failures: PatentImportFailure[],
): string {
  const base = `导入未完成：已导入 ${importedCount} / ${totalPatents} 条记录`
  return failures.length > 0 ? `${base}，失败 ${failures.length} 条` : base
}

export async function runImportStep(batchCode: string): Promise<StepResult> {
  const batch = await getBatchByCode(batchCode)
  if (!batch) return { success: false, batchCode, error: '批次不存在' }
  if (!['processed', 'importing'].includes(batch.status)) {
    return {
      success: false,
      batchCode,
      error: `当前状态 ${batch.status} 不可执行导入，需要 processed 或 importing`,
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
    const parsedPath = path.join(getTempPath(batchCode), 'parsed.json')
    if (!fs.existsSync(parsedPath)) {
      throw new Error('parsed.json 不存在，请先执行处理步骤')
    }

    await addLog(batchCode, 'info', '正在逐条检查解析结果并建立导入索引…')
    const { latestIndexes, recordCount } = await indexParsedPatentFile(
      parsedPath,
      () => cancelled,
    )
    const totalPatents = latestIndexes.size
    let importedCount = await countImportedPatentsByBatch(batchCode)

    await updateBatchProgress(
      batchCode,
      undefined,
      undefined,
      totalPatents,
      importedCount,
    )

    if (importedCount >= totalPatents) {
      await updateBatchStatus(batchCode, 'completed')
      await addLog(
        batchCode,
        'info',
        `导入已完成：${importedCount} / ${totalPatents} 条记录`,
      )
      return {
        success: true,
        batchCode,
        details: { importedPatents: importedCount, totalPatents },
      }
    }

    await updateBatchStatus(batchCode, 'importing')
    if (recordCount !== totalPatents) {
      await addLog(
        batchCode,
        'warn',
        `导入前去重：parsed.json ${recordCount} 条，唯一专利 ${totalPatents} 条`,
      )
    }
    await addLog(
      batchCode,
      'info',
      `开始导入步骤：已导入 ${importedCount} / ${totalPatents} 条记录`,
    )

    const importedKeys = await getImportedPatentKeysByBatch(batchCode)
    const CONCURRENCY = Math.max(
      1,
      parseInt(process.env.IMPORT_CONCURRENCY || '3', 10) || 3,
    )

    for await (const activeChunks of readPatentImportGroups(
      parsedPath,
      latestIndexes,
      importedKeys,
      CONCURRENCY,
      () => cancelled,
    )) {
      if (cancelled) throw new Error('任务已取消')

      const results = await Promise.allSettled(
        activeChunks.map((chunk) => insertPatents(batchCode, chunk)),
      )
      const errors = results
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map((r) => r.reason)
      if (errors.length > 0) {
        throw new AggregateError(
          errors,
          `${errors.length}/${activeChunks.length} 个导入块失败`,
        )
      }
      const failures: PatentImportFailure[] = []
      for (const r of results) {
        const result = r as PromiseFulfilledResult<PatentImportResult>
        importedCount += result.value.insertedCount
        failures.push(...result.value.failures)
      }

      await updateBatchProgress(
        batchCode,
        undefined,
        undefined,
        undefined,
        importedCount,
      )

      if (failures.length > 0) {
        const latestImportedCount = await countImportedPatentsByBatch(batchCode)
        const errorMessage = formatImportFailureMessage(
          latestImportedCount,
          totalPatents,
          failures,
        )
        await updateBatchProgress(
          batchCode,
          undefined,
          undefined,
          totalPatents,
          latestImportedCount,
        )
        await updateBatchStatus(batchCode, 'failed', errorMessage)
        await addLog(batchCode, 'error', errorMessage, {
          failures,
          importedPatents: latestImportedCount,
          totalPatents,
        })
        return {
          success: false,
          batchCode,
          error: errorMessage,
          details: {
            importedPatents: latestImportedCount,
            totalPatents,
            failures,
          },
        }
      }
    }

    importedCount = await countImportedPatentsByBatch(batchCode)
    await updateBatchProgress(
      batchCode,
      undefined,
      undefined,
      totalPatents,
      importedCount,
    )
    await addLog(
      batchCode,
      'info',
      `导入完成：${importedCount} / ${totalPatents} 条记录`,
    )

    if (importedCount < totalPatents) {
      throw new Error(
        formatImportFailureMessage(importedCount, totalPatents, []),
      )
    }

    await updateBatchStatus(batchCode, 'completed')
    await updateBatchProgress(
      batchCode,
      undefined,
      undefined,
      totalPatents,
      importedCount,
    )

    await addLog(batchCode, 'info', 'ETL 任务全部完成，可手动清理本地文件')

    return {
      success: true,
      batchCode,
      details: { importedPatents: importedCount, totalPatents },
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : '未知错误'
    await updateBatchStatus(batchCode, 'failed', errorMessage)
    await addLog(batchCode, 'error', `导入失败：${errorMessage}`)
    return { success: false, batchCode, error: errorMessage }
  } finally {
    runningTasks.delete(batchCode)
  }
}
