import { NextRequest, NextResponse } from 'next/server'
import { getBatchByCode, deleteBatch, getLogsByBatch } from '@/lib/db'
import { cleanTempDir, getTempDirState } from '@/lib/temp-dir'

// GET /api/batches/[batch_code] - 获取批次详情
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ batch_code: string }> },
) {
  try {
    const { batch_code } = await params

    if (!batch_code) {
      return NextResponse.json(
        { success: false, error: '缺少批次编号' },
        { status: 400 },
      )
    }

    const batch = await getBatchByCode(batch_code)

    if (!batch) {
      return NextResponse.json(
        { success: false, error: '批次不存在' },
        { status: 404 },
      )
    }

    // 获取日志
    const logs = await getLogsByBatch(batch_code, 100)

    return NextResponse.json({
      success: true,
      data: {
        batch,
        logs,
        localTemp: getTempDirState(batch_code),
        localExtract: getTempDirState(`${batch_code}/extracted`),
      },
    })
  } catch (error) {
    console.error('获取批次详情失败:', error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : '获取失败',
      },
      { status: 500 },
    )
  }
}

// DELETE /api/batches/[batch_code] - 删除批次
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ batch_code: string }> },
) {
  try {
    const { batch_code } = await params

    if (!batch_code) {
      return NextResponse.json(
        { success: false, error: '缺少批次编号' },
        { status: 400 },
      )
    }

    const batch = await getBatchByCode(batch_code)

    if (!batch) {
      return NextResponse.json(
        { success: false, error: '批次不存在' },
        { status: 404 },
      )
    }

    // 不允许删除正在运行的批次
    if (['downloading', 'processing', 'importing'].includes(batch.status)) {
      return NextResponse.json(
        { success: false, error: '不能删除正在运行的批次' },
        { status: 400 },
      )
    }

    const localTempBeforeDelete = getTempDirState(batch_code)
    await deleteBatch(batch_code)
    cleanTempDir(batch_code)

    return NextResponse.json({
      success: true,
      message: '批次已删除',
      data: {
        localTempBeforeDelete,
        localTemp: getTempDirState(batch_code),
      },
    })
  } catch (error) {
    console.error('删除批次失败:', error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : '删除失败',
      },
      { status: 500 },
    )
  }
}
