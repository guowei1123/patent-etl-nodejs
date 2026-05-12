import { NextRequest, NextResponse } from 'next/server'
import { syncBatchRecord } from '@/lib/etl-pipeline'
import { initializeDatabase, getBatchByCode } from '@/lib/db'

// POST /api/sync/fix - 同步修复批次记录状态
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { batch_code } = body

    if (!batch_code) {
      return NextResponse.json(
        { success: false, error: '缺少 batch_code 参数' },
        { status: 400 },
      )
    }

    await initializeDatabase()

    const existing = await getBatchByCode(batch_code)
    if (!existing) {
      return NextResponse.json(
        { success: false, error: '批次记录不存在' },
        { status: 404 },
      )
    }

    const result = await syncBatchRecord(batch_code)

    return NextResponse.json({
      success: result.success,
      data: result,
    })
  } catch (error) {
    console.error('同步修复失败:', error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : '同步失败',
      },
      { status: 500 },
    )
  }
}
