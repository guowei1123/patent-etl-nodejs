import { getBatchByCode } from './db'
import { runDownloadStep } from './etl/download-step'
import { runProcessStep } from './etl/process-step'
import { runImportStep } from './etl/import-step'
import { isTaskRunning } from './etl/task-state'
import type { SyncBatch } from '@/types'
import type { StepResult } from './etl/types'

export type { StepResult } from './etl/types'
export {
  getDownloadProgress,
  getDownloadFileList,
  isTaskRunning,
  isTaskCancelling,
  cancelTask,
} from './etl/task-state'
export { runDownloadStep } from './etl/download-step'
export { runProcessStep } from './etl/process-step'
export {
  dedupePatentsForImport,
  filterRemainingPatentsForImport,
  getPatentImportKey,
  runImportStep,
} from './etl/import-step'
export { syncBatchRecord } from './etl/batch-sync'

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

export const stepFunctions: Record<
  string,
  (batchCode: string) => Promise<StepResult>
> = {
  download: runDownloadStep,
  process: runProcessStep,
  import: runImportStep,
}
