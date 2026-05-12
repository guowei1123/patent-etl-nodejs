import { NextRequest, NextResponse } from 'next/server'
import { getAllBatches, createBatch, initializeDatabase } from '@/lib/db'
import type { BatchStatus, PatentType } from '@/types'

// GET /api/batches - 获取批次列表
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams
    const page = parseInt(searchParams.get('page') || '1')
    const limit = parseInt(searchParams.get('limit') || '20')
    const status = searchParams.get('status') as BatchStatus | null
    const activeOnly = searchParams.get('active') === 'true'

    // 确保数据库表存在
    await initializeDatabase()

    const result = await getAllBatches(
      page,
      limit,
      activeOnly ? undefined : status || undefined,
      activeOnly,
    )

    return NextResponse.json({
      success: true,
      data: result,
    })
  } catch (error) {
    console.error('获取批次列表失败:', error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : '获取失败',
      },
      { status: 500 },
    )
  }
}

// POST /api/batches - 创建新批次
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { batch_code, data_type, ftp_folder } = body

    if (!batch_code || !data_type || !ftp_folder) {
      return NextResponse.json(
        {
          success: false,
          error: '缺少必填字段: batch_code, data_type, ftp_folder',
        },
        { status: 400 },
      )
    }

    if (!['invention', 'utility_model'].includes(data_type)) {
      return NextResponse.json(
        { success: false, error: '无效的数据类型' },
        { status: 400 },
      )
    }

    // 确保数据库表存在
    await initializeDatabase()

    const batch = await createBatch(
      batch_code,
      data_type as PatentType,
      ftp_folder,
    )

    return NextResponse.json({
      success: true,
      data: batch,
      message: '批次创建成功',
    })
  } catch (error) {
    console.error('创建批次失败:', error)

    // 处理唯一约束冲突
    if (error instanceof Error && error.message.includes('unique')) {
      return NextResponse.json(
        { success: false, error: '批次编号已存在' },
        { status: 409 },
      )
    }

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : '创建失败',
      },
      { status: 500 },
    )
  }
}
