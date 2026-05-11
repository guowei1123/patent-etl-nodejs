import { NextRequest, NextResponse } from 'next/server'
import { getBatchById } from '@/lib/db'
import { isTaskRunning, cancelTask } from '@/lib/etl-pipeline'

// GET /api/sync/status?batch_id=xxx - 获取同步状态
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams
    const batchId = searchParams.get('batch_id')

    if (!batchId) {
      return NextResponse.json(
        { success: false, error: '缺少 batch_id 参数' },
        { status: 400 },
      )
    }

    const id = parseInt(batchId)
    if (isNaN(id)) {
      return NextResponse.json(
        { success: false, error: '无效的 batch_id' },
        { status: 400 },
      )
    }

    const batch = await getBatchById(id)

    if (!batch) {
      return NextResponse.json(
        { success: false, error: '批次不存在' },
        { status: 404 },
      )
    }

    const running = isTaskRunning(id)

    // 计算进度百分比
    let progress = 0
    if (batch.status === 'completed') {
      progress = 100
    } else if (batch.total_files > 0 || batch.total_patents > 0) {
      if (batch.status === 'downloading') {
        progress = Math.min(
          25,
          (batch.processed_files / Math.max(batch.total_files, 1)) * 25,
        )
      } else if (batch.status === 'extracting') {
        progress =
          25 +
          Math.min(
            25,
            (batch.processed_files / Math.max(batch.total_files, 1)) * 25,
          )
      } else if (batch.status === 'parsing') {
        progress =
          50 +
          Math.min(
            25,
            (batch.imported_patents / Math.max(batch.total_patents, 1)) * 25,
          )
      } else if (batch.status === 'importing') {
        progress =
          75 +
          Math.min(
            25,
            (batch.imported_patents / Math.max(batch.total_patents, 1)) * 25,
          )
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        batch,
        is_running: running,
        progress: Math.round(progress),
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
    const { batch_id, action } = body

    if (!batch_id || action !== 'cancel') {
      return NextResponse.json(
        { success: false, error: '缺少参数或无效的操作' },
        { status: 400 },
      )
    }

    const id = parseInt(batch_id)
    if (isNaN(id)) {
      return NextResponse.json(
        { success: false, error: '无效的 batch_id' },
        { status: 400 },
      )
    }

    if (!isTaskRunning(id)) {
      return NextResponse.json(
        { success: false, error: '该任务未在运行' },
        { status: 400 },
      )
    }

    const cancelled = cancelTask(id)

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
