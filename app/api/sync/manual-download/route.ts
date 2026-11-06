import { NextRequest, NextResponse } from 'next/server'
import { getBatchByCode, initializeDatabase } from '@/lib/db'
import { enqueueAutoTask, getActiveAutoTask, getAutoStageLaunchLimit } from '@/lib/etl/auto-queue'
import {
  startInlineScheduler,
  wakeInlineScheduler,
} from '@/lib/etl/inline-scheduler'

// POST /api/sync/manual-download - 将等待下载的批次提升为手动扩容下载
export async function POST(request: NextRequest) {
  try {
    const { batch_code } = (await request.json()) as { batch_code?: string }
    if (!batch_code) {
      return NextResponse.json(
        { success: false, error: '缺少 batch_code 参数' },
        { status: 400 },
      )
    }

    await initializeDatabase()
    const batch = await getBatchByCode(batch_code)
    if (!batch) {
      return NextResponse.json(
        { success: false, error: '批次不存在' },
        { status: 404 },
      )
    }
    if (batch.status !== 'pending') {
      return NextResponse.json(
        { success: false, error: `当前状态 ${batch.status} 不可手动下载，需要 pending` },
        { status: 409 },
      )
    }

    const activeTask = await getActiveAutoTask(batch_code)
    if (activeTask && activeTask.stage !== 'download') {
      return NextResponse.json(
        { success: false, error: '该批次已进入后续阶段，不能重新加入下载队列' },
        { status: 409 },
      )
    }
    if (activeTask?.status === 'running') {
      return NextResponse.json(
        { success: false, error: '该批次正在下载中' },
        { status: 409 },
      )
    }

    const task = await enqueueAutoTask(batch_code, 'download', {
      priority: 100,
      manualOverride: true,
    })
    startInlineScheduler()
    wakeInlineScheduler()

    return NextResponse.json({
      success: true,
      data: { batch_code, task },
      message: `已加入手动扩容下载队列，下载总并发上限为 ${getAutoStageLaunchLimit('download')} 个批次`,
    })
  } catch (error) {
    console.error('手动扩容下载失败:', error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : '手动下载失败',
      },
      { status: 500 },
    )
  }
}
