import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase, getBatchByCode, addLog } from '@/lib/db'
import { isTaskRunning } from '@/lib/etl-pipeline'
import { getActiveAutoTask } from '@/lib/etl/auto-queue'
import { cleanTempDir, getTempDirState } from '@/lib/temp-dir'

// POST /api/sync/cleanup - 手动清理已完成批次的本地临时文件
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { batch_code, confirm } = body as {
      batch_code?: string
      confirm?: boolean
    }

    if (!batch_code) {
      return NextResponse.json(
        { success: false, error: '缺少 batch_code 参数' },
        { status: 400 },
      )
    }

    if (confirm !== true) {
      return NextResponse.json(
        { success: false, error: '请确认后再清理本地文件' },
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

    const autoTask = await getActiveAutoTask(batch_code)
    if (isTaskRunning(batch_code) || autoTask) {
      return NextResponse.json(
        { success: false, error: '该批次已有自动任务在运行或等待中，无法清理' },
        { status: 409 },
      )
    }

    if (batch.status !== 'completed') {
      return NextResponse.json(
        { success: false, error: '仅已完成批次允许清理本地文件' },
        { status: 400 },
      )
    }

    const before = getTempDirState(batch_code)
    if (!before.exists || !before.hasFiles) {
      return NextResponse.json({
        success: true,
        message: '本地文件已清理',
        data: getTempDirState(batch_code),
      })
    }

    await cleanTempDir(batch_code)
    await addLog(batch_code, 'info', '[手动清理] 本地临时文件已清除')

    return NextResponse.json({
      success: true,
      message: '本地文件已清理',
      data: getTempDirState(batch_code),
    })
  } catch (error) {
    console.error('清理本地文件失败:', error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : '清理失败',
      },
      { status: 500 },
    )
  }
}
