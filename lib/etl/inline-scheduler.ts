import { randomUUID } from 'crypto'
import { addLog, getPool } from '@/lib/db'
import { runDownloadStep } from './download-step'
import { runProcessStep } from './process-step'
import { runImportStep } from './import-step'
import {
  cancelTask,
  getDownloadFileList,
  getDownloadProgress,
  getProcessProgress,
} from './task-state'
import {
  cleanTempDir,
  getTempBatchDirectories,
  getTempDirState,
} from '@/lib/temp-dir'
import {
  AUTO_STAGES,
  type AutoStage,
  type AutoSyncTask,
  cancelAutoTask,
  claimNextAutoTask,
  completeAutoTask,
  enqueueCompletedBatchCleanupTasks,
  enqueueAutoTask,
  failAutoTask,
  getAutoStageLaunchLimit,
  heartbeatAutoTask,
} from './auto-queue'

const POLL_INTERVAL_MS = 2_000
const HEARTBEAT_INTERVAL_MS = 2_000

type SchedulerState = {
  scheduler: InlineScheduler
  timer: ReturnType<typeof setInterval>
}

declare global {
  var __patentAutoSyncScheduler: SchedulerState | undefined
}

function prerequisiteStatus(stage: AutoStage): string | null {
  switch (stage) {
    case 'download':
      return 'pending'
    case 'process':
      return 'downloaded'
    case 'import':
      return 'processed'
    case 'cleanup':
      return null
  }
}

class InlineScheduler {
  private readonly workerId = `inline-${process.pid}-${randomUUID()}`
  private ticking = false

  async reconcileCompletedBatchCleanupTasks(): Promise<void> {
    const batchCodes = getTempBatchDirectories()
    const tasks = await enqueueCompletedBatchCleanupTasks(batchCodes)
    if (tasks.length > 0) {
      console.info(
        `自动清理恢复：已将 ${tasks.length} 个已完成批次加入清理队列`,
      )
    }
  }

  async kick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      for (const stage of AUTO_STAGES) {
        for (let slot = 0; slot < getAutoStageLaunchLimit(stage); slot++) {
          const task = await claimNextAutoTask(stage, this.workerId)
          if (!task) break
          void this.execute(task).catch((error) => {
            console.error('自动同步任务执行失败:', error)
          })
        }
      }
    } catch (error) {
      console.error('自动同步调度失败:', error)
    } finally {
      this.ticking = false
    }
  }

  private async execute(task: AutoSyncTask): Promise<void> {
    let progressDetails: Record<string, unknown> | null = null
    let cancelRequested = false
    let heartbeatInFlight = false
    let heartbeatFailed = false
    let heartbeat: ReturnType<typeof setInterval> | undefined
    const runHeartbeat = () => {
      // 数据库连接超时时，避免多个尚未完成的心跳继续占用连接池。
      if (heartbeatInFlight) return

      const current = this.readProgress(task.stage, task.batch_code)
      if (current) progressDetails = current

      heartbeatInFlight = true
      void heartbeatAutoTask(task.id, this.workerId, progressDetails)
        .then((result) => {
          heartbeatFailed = false
          if (result.cancelRequested && !cancelRequested) {
            cancelRequested = true
            cancelTask(task.batch_code)
          }
        })
        .catch((error) => {
          // 心跳失败不应产生未处理的 Promise 拒绝。任务本身仍会在后续
          // 心跳或完成/失败写回时重试数据库操作。
          if (!heartbeatFailed) {
            heartbeatFailed = true
            console.error('自动同步任务心跳失败，将在下次心跳时重试:', error)
          }
        })
        .finally(() => {
          heartbeatInFlight = false
        })
    }

    try {
      const initialHeartbeat = await heartbeatAutoTask(
        task.id,
        this.workerId,
        null,
      )
      if (!initialHeartbeat.alive) return
      if (initialHeartbeat.cancelRequested) {
        await cancelAutoTask(task.id, this.workerId)
        return
      }

      heartbeat = setInterval(runHeartbeat, HEARTBEAT_INTERVAL_MS)

      if (task.stage === 'cleanup') {
        const localFiles = getTempDirState(task.batch_code)
        await cleanTempDir(task.batch_code)
        const remainingFiles = getTempDirState(task.batch_code)
        if (remainingFiles.exists) {
          throw new Error(
            `本地临时文件仍存在，未完成清理：${remainingFiles.path}`,
          )
        }
        await addLog(
          task.batch_code,
          'info',
          localFiles.exists
            ? '[自动清理] 导入完成后已清除本地临时文件'
            : '[自动清理] 本地临时文件已不存在，无需清理',
        )
      } else {
        const result = await this.runStage(task)
        if (!result.success) {
          throw new Error(result.error || `${task.stage} 阶段执行失败`)
        }
      }

      progressDetails =
        this.readProgress(task.stage, task.batch_code) ?? progressDetails
      await completeAutoTask(task.id, this.workerId, progressDetails)

      if (task.stage === 'download') {
        await enqueueAutoTask(task.batch_code, 'process')
      } else if (task.stage === 'process') {
        await enqueueAutoTask(task.batch_code, 'import')
      } else if (task.stage === 'import') {
        await enqueueAutoTask(task.batch_code, 'cleanup')
      }
      void this.kick()
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '自动任务失败'
      // 状态写回本身也可能失败，先保存到控制台，避免原始阶段错误被二次错误覆盖。
      console.error('自动同步阶段失败:', {
        batchCode: task.batch_code,
        stage: task.stage,
        error: errorMessage,
      })
      try {
        if (cancelRequested || errorMessage === '任务已取消') {
          await cancelAutoTask(task.id, this.workerId)
          await addLog(task.batch_code, 'warn', `[自动队列] ${task.stage} 阶段已取消`)
        } else {
          const failure = await failAutoTask(task, this.workerId, errorMessage)
          if (failure.retrying) {
            await this.resetForRetry(task)
            await addLog(
              task.batch_code,
              'warn',
              `[自动队列] ${task.stage} 阶段失败，将在 30 秒后重试（${task.attempt_count}/${task.max_attempts}）：${errorMessage}`,
            )
          } else {
            await addLog(
              task.batch_code,
              'error',
              `[自动队列] ${task.stage} 阶段已达到最大重试次数：${errorMessage}`,
            )
          }
        }
      } catch (recoveryError) {
        // 若写回未成功，保留租约，由后续轮询按过期租约及重试上限恢复。
        console.error('自动同步任务失败处理未完成，将按队列状态和租约恢复:', {
          batchCode: task.batch_code,
          stage: task.stage,
          originalError: errorMessage,
          recoveryError,
        })
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat)
      void this.kick()
    }
  }

  private async runStage(task: AutoSyncTask) {
    if (task.stage === 'download') return runDownloadStep(task.batch_code)
    if (task.stage === 'process') return runProcessStep(task.batch_code)
    return runImportStep(task.batch_code)
  }

  private readProgress(
    stage: AutoStage,
    batchCode: string,
  ): Record<string, unknown> | null {
    if (stage === 'download') {
      const currentFile = getDownloadProgress(batchCode)
      const fileList = getDownloadFileList(batchCode)
      if (!currentFile && !fileList) return null

      const totalBytes =
        fileList?.reduce((total, file) => total + file.fileSize, 0) ?? 0
      const downloadedBytes =
        fileList?.reduce(
          (total, file) =>
            total + Math.min(Math.max(file.bytesDownloaded, 0), file.fileSize),
          0,
        ) ?? 0
      const completedFiles =
        fileList?.filter(
          (file) => file.status === 'completed' || file.status === 'skipped',
        ).length ?? 0

      return {
        stage,
        current_file: currentFile,
        // 仅保留有限文件清单，避免大批次进度数据无限增长。
        file_list: fileList?.slice(0, 100),
        total_bytes: totalBytes,
        downloaded_bytes: downloadedBytes,
        completed_files: completedFiles,
        total_files: fileList?.length ?? 0,
        updated_at: new Date().toISOString(),
      }
    }

    if (stage === 'process') {
      const processProgress = getProcessProgress(batchCode)
      return processProgress
        ? { stage, process_progress: processProgress }
        : null
    }

    return { stage, updated_at: new Date().toISOString() }
  }

  private async resetForRetry(task: AutoSyncTask): Promise<void> {
    const status = prerequisiteStatus(task.stage)
    if (!status) return
    const pool = await getPool()
    await pool.query(
      `UPDATE sync_batches
          SET status = $2, error_message = NULL, completed_at = NULL
        WHERE batch_code = $1`,
      [task.batch_code, status],
    )
  }
}

export function startInlineScheduler(): void {
  if (globalThis.__patentAutoSyncScheduler) {
    const { scheduler } = globalThis.__patentAutoSyncScheduler
    void scheduler.reconcileCompletedBatchCleanupTasks().then(
      () => scheduler.kick(),
      (error) => console.error('恢复已完成批次清理任务失败:', error),
    )
    return
  }
  const scheduler = new InlineScheduler()
  const timer = setInterval(() => void scheduler.kick(), POLL_INTERVAL_MS)
  globalThis.__patentAutoSyncScheduler = { scheduler, timer }
  void scheduler.reconcileCompletedBatchCleanupTasks().then(
    () => scheduler.kick(),
    (error) => console.error('恢复已完成批次清理任务失败:', error),
  )
  void scheduler.kick()
}

export function wakeInlineScheduler(): void {
  globalThis.__patentAutoSyncScheduler?.scheduler.kick()
}
