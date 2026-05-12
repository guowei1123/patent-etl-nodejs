import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase, createBatch, getBatchByCode } from '@/lib/db'
import type { PatentType } from '@/types'

// POST /api/sync/start - 创建批次记录（不再自动启动流水线）
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

    await initializeDatabase()

    const existing = await getBatchByCode(batch_code)
    if (existing) {
      return NextResponse.json(
        { success: false, error: '批次编号已存在' },
        { status: 409 },
      )
    }

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
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : '创建失败',
      },
      { status: 500 },
    )
  }
}
