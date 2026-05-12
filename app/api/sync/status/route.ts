import { NextRequest, NextResponse } from 'next/server'
import { getBatchByCode } from '@/lib/db'
import {
  isTaskRunning,
  cancelTask,
  getDownloadProgress,
  getDownloadFileList,
} from '@/lib/etl-pipeline'

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

    const running = isTaskRunning(batchCode)

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

    return NextResponse.json({
      success: true,
      data: {
        batch,
        is_running: running,
        progress: Math.round(progress),
        current_file: running ? getDownloadProgress(batchCode) : null,
        file_list: running ? getDownloadFileList(batchCode) : null,
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

    if (!isTaskRunning(batch_code)) {
      return NextResponse.json(
        { success: false, error: '该任务未在运行' },
        { status: 400 },
      )
    }

    const cancelled = cancelTask(batch_code)

    return NextResponse.json({
      success: cancelled,
      message: cancelled ? '取消请求已发送' : '取消失败',
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
