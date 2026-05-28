import { NextRequest, NextResponse } from 'next/server'
import {
  initializeDatabase,
  createBatch,
  getBatchByCode,
  getBatchByFtpFolder,
} from '@/lib/db'
import { generateBatchCode } from '@/lib/batch-code'
import type { PatentType } from '@/types'

// POST /api/sync/start - 创建批次记录（不再自动启动流水线）
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { data_type, ftp_folder } = body

    if (!data_type || !ftp_folder) {
      return NextResponse.json(
        {
          success: false,
          error: '缺少必填字段: data_type, ftp_folder',
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

    const batchCode = generateBatchCode(data_type as PatentType, ftp_folder)

    const existingByFolder = await getBatchByFtpFolder(ftp_folder)
    if (existingByFolder) {
      return NextResponse.json(
        {
          success: false,
          error: `该 FTP 文件夹已创建批次: ${existingByFolder.batch_code}`,
          data: existingByFolder,
        },
        { status: 409 },
      )
    }

    const batch_code = batchCode
    const existing = await getBatchByCode(batch_code)
    if (existing) {
      return NextResponse.json(
        {
          success: false,
          error: `自动生成的批次编号已存在: ${batch_code}`,
          data: existing,
        },
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
