import { NextRequest, NextResponse } from 'next/server'
import { runETLPipeline, isTaskRunning } from '@/lib/etl-pipeline'
import { initializeDatabase, getBatchByCode } from '@/lib/db'
import { isFtpConfigured } from '@/lib/ftp-client'
import type { PatentType } from '@/types'

// POST /api/sync/start - 启动同步任务
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { batch_code, data_type, ftp_folder, include_raw_xml = false } = body

    // 验证必填参数
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
        {
          success: false,
          error: '无效的数据类型，请选择 invention 或 utility_model',
        },
        { status: 400 },
      )
    }

    // 检查 FTP 配置
    if (!isFtpConfigured()) {
      return NextResponse.json(
        {
          success: false,
          error: 'FTP 配置未设置，请在设置页面配置 FTP 连接信息',
        },
        { status: 400 },
      )
    }

    // 确保数据库表存在
    await initializeDatabase()

    // 检查批次是否已存在，避免异步任务在 createBatch 时因为唯一约束失败
    const existingBatch = await getBatchByCode(batch_code)
    if (existingBatch) {
      if (isTaskRunning(existingBatch.id)) {
        return NextResponse.json(
          { success: false, error: '该批次任务正在运行中' },
          { status: 409 },
        )
      }

      if (existingBatch.status === 'completed') {
        return NextResponse.json(
          { success: false, error: '该批次已完成，请使用新的批次编号' },
          { status: 409 },
        )
      }

      return NextResponse.json(
        {
          success: false,
          error: '该批次编号已存在，请使用新的批次编号重新创建任务',
        },
        { status: 409 },
      )
    }

    // 启动 ETL 任务（异步执行，不等待完成）
    runETLPipeline({
      batchCode: batch_code,
      dataType: data_type as PatentType,
      ftpFolder: ftp_folder,
      includeRawXml: include_raw_xml,
    }).catch((error) => {
      console.error('ETL任务执行失败:', error)
    })

    return NextResponse.json({
      success: true,
      message: 'ETL任务已启动',
      data: {
        batch_code,
        data_type,
        ftp_folder,
      },
    })
  } catch (error) {
    console.error('启动同步任务失败:', error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : '启动失败',
      },
      { status: 500 },
    )
  }
}
