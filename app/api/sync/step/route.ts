import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase, getBatchByCode } from '@/lib/db'
import {
  enqueueAutoTask,
  getActiveAutoTask,
  parseAutoStage,
} from '@/lib/etl/auto-queue'
import { startInlineScheduler, wakeInlineScheduler } from '@/lib/etl/inline-scheduler'

const VALID_STEPS = ['download', 'process', 'import']

const STEP_LABELS: Record<string, string> = {
  download: '下载',
  process: '处理',
  import: '导入',
}

const STEP_REQUIRED_STATUS: Record<string, string> = {
  download: 'pending',
  process: 'downloaded',
  import: 'processed',
}

// POST /api/sync/step - 执行单个步骤
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { batch_code, step } = body

    if (!batch_code || !step) {
      return NextResponse.json(
        { success: false, error: '缺少 batch_code 或 step 参数' },
        { status: 400 },
      )
    }

    if (!VALID_STEPS.includes(step)) {
      return NextResponse.json(
        {
          success: false,
          error: `无效的步骤: ${step}，可选: ${VALID_STEPS.join(', ')}`,
        },
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

    const stage = parseAutoStage(step)
    if (!stage || stage === 'cleanup') {
      return NextResponse.json(
        { success: false, error: '无效的自动执行步骤' },
        { status: 400 },
      )
    }

    if (batch.status !== STEP_REQUIRED_STATUS[stage]) {
      return NextResponse.json(
        {
          success: false,
          error: `当前状态 ${batch.status} 不可执行${STEP_LABELS[step]}，需要 ${STEP_REQUIRED_STATUS[stage]}`,
        },
        { status: 409 },
      )
    }

    const activeTask = await getActiveAutoTask(batch_code)
    if (activeTask && activeTask.stage !== stage) {
      return NextResponse.json(
        {
          success: false,
          error: `该批次正在${STEP_LABELS[activeTask.stage] || activeTask.stage}队列中，不能启动${STEP_LABELS[step]}`,
        },
        { status: 409 },
      )
    }

    const task = await enqueueAutoTask(batch_code, stage, { priority: 100 })
    startInlineScheduler()
    wakeInlineScheduler()

    return NextResponse.json({
      success: true,
      message: `${STEP_LABELS[step]}已加入自动队列并提高优先级`,
      data: { batch_code, step, task },
    })
  } catch (error) {
    console.error('执行步骤失败:', error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : '执行失败',
      },
      { status: 500 },
    )
  }
}
