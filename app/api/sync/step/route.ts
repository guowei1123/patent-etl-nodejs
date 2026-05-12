import { NextRequest, NextResponse } from 'next/server'
import { isTaskRunning, stepFunctions } from '@/lib/etl-pipeline'
import { initializeDatabase, getBatchByCode } from '@/lib/db'

const VALID_STEPS = ['download', 'process', 'import']

const STEP_LABELS: Record<string, string> = {
  download: '下载',
  process: '处理',
  import: '导入',
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

    if (isTaskRunning(batch_code)) {
      return NextResponse.json(
        { success: false, error: '该批次已有任务在运行中' },
        { status: 409 },
      )
    }

    const stepFn = stepFunctions[step]
    if (!stepFn) {
      return NextResponse.json(
        { success: false, error: `步骤函数未找到: ${step}` },
        { status: 500 },
      )
    }

    // 异步执行步骤
    stepFn(batch_code).catch((error) => {
      console.error(`步骤 ${step} 执行失败:`, error)
    })

    return NextResponse.json({
      success: true,
      message: `${STEP_LABELS[step]}步骤已启动`,
      data: { batch_code, step },
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
