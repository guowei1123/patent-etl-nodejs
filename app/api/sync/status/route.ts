import { NextRequest, NextResponse } from 'next/server'
import { getBatchByCode } from '@/lib/db'
import {
  isTaskRunning,
  cancelTask,
  getDownloadProgress,
  getDownloadFileList,
  getProcessProgress,
} from '@/lib/etl-pipeline'
import {
  getActiveAutoTask,
  requestAutoTaskCancellation,
  type AutoSyncTask,
} from '@/lib/etl/auto-queue'
import type {
  FileDownloadItem,
  FileDownloadProgress,
  ProcessProgress,
} from '@/types'

function getProgressDetails(task: AutoSyncTask | null): Record<string, unknown> {
  return task?.progress_details ?? {}
}

function getQueuedProgress(
  task: AutoSyncTask | null,
  fallback: number,
): number {
  if (!task) return fallback
  const details = getProgressDetails(task)
  if (task.stage === 'download') {
    const totalBytes = Number(details.total_bytes ?? 0)
    const downloadedBytes = Number(details.downloaded_bytes ?? 0)
    if (totalBytes > 0) {
      return Math.min(Math.round((downloadedBytes / totalBytes) * 33), 33)
    }
    return 0
  }
  if (task.stage === 'process') {
    const process = details.process_progress as ProcessProgress | undefined
    if (process?.totalZips) {
      return Math.min(
        66,
        33 + Math.round((process.processedZips / process.totalZips) * 33),
      )
    }
    return 33
  }
  if (task.stage === 'import') return Math.max(fallback, 66)
  return 100
}

// GET /api/sync/status?batch_code=xxx - 获取同步状态
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams
    const batchCode = searchParams.get('batch_code')

    if (!batchCode) {
      return NextResponse.json(
        { success: false, error: '缺少 batch_code 参数' },
        { status: 400 },
      )
    }

    const batch = await getBatchByCode(batchCode)

    if (!batch) {
      return NextResponse.json(
        { success: false, error: '批次不存在' },
        { status: 404 },
      )
    }

    // 自动队列是跨请求、跨服务重启的权威状态；内存状态只用于兼容旧的手动任务。
    const autoTask = await getActiveAutoTask(batchCode).catch(() => null)
    const running = Boolean(autoTask) || isTaskRunning(batchCode)

    // 计算进度百分比
    let progress = 0
    if (batch.status === 'completed') {
      progress = 100
    } else {
      const progressMap: Record<string, number> = {
        pending: 0,
        downloading: 0,
        downloaded: 33,
        processing: 33,
        processed: 66,
        importing: 66,
        failed: 0,
      }
      const base = progressMap[batch.status] ?? 0

      const isActive = ['downloading', 'processing', 'importing'].includes(
        batch.status,
      )
      if (isActive && (batch.total_files > 0 || batch.total_patents > 0)) {
        const stageProgress =
          batch.status === 'importing' && batch.total_patents > 0
            ? (batch.imported_patents / Math.max(batch.total_patents, 1)) * 25
            : batch.total_files > 0
              ? (batch.processed_files / Math.max(batch.total_files, 1)) * 25
              : 0
        progress = base + Math.min(stageProgress, 25)
      } else {
        progress = base
      }
    }

    const details = getProgressDetails(autoTask)
    const queuedCurrentFile =
      (details.current_file as FileDownloadProgress | undefined) ?? null
    const queuedFileList =
      (details.file_list as FileDownloadItem[] | undefined) ?? null
    const queuedProcessProgress =
      (details.process_progress as ProcessProgress | undefined) ?? null

    return NextResponse.json({
      success: true,
      data: {
        batch,
        is_running: running,
        progress: getQueuedProgress(autoTask, Math.round(progress)),
        queue_task: autoTask,
        current_file: running
          ? getDownloadProgress(batchCode) ?? queuedCurrentFile
          : null,
        file_list: running
          ? getDownloadFileList(batchCode) ?? queuedFileList
          : null,
        process_progress: running
          ? getProcessProgress(batchCode) ?? queuedProcessProgress
          : null,
      },
    })
  } catch (error) {
    console.error('获取同步状态失败:', error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : '获取失败',
      },
      { status: 500 },
    )
  }
}

// POST /api/sync/status - 取消任务
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { batch_code, action } = body

    if (!batch_code || action !== 'cancel') {
      return NextResponse.json(
        { success: false, error: '缺少参数或无效的操作' },
        { status: 400 },
      )
    }

    const queueCancellation = await requestAutoTaskCancellation(batch_code).catch(
      () => ({ requested: false, running: false }),
    )
    const legacyRunning = isTaskRunning(batch_code)

    if (!queueCancellation.requested && !legacyRunning) {
      return NextResponse.json(
        { success: false, error: '该任务未在运行' },
        { status: 400 },
      )
    }

    const cancelled = legacyRunning ? cancelTask(batch_code) : false

    return NextResponse.json({
      success: queueCancellation.requested || cancelled,
      message: queueCancellation.running || cancelled ? '取消请求已发送' : '已取消队列任务',
    })
  } catch (error) {
    console.error('取消任务失败:', error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : '取消失败',
      },
      { status: 500 },
    )
  }
}
