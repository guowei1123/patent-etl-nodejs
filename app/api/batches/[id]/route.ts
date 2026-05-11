import { NextRequest, NextResponse } from 'next/server'
import { getBatchById, deleteBatch, getLogsByBatch } from '@/lib/db'

// GET /api/batches/[id] - 获取批次详情
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const batchId = parseInt(id)

    if (isNaN(batchId)) {
      return NextResponse.json(
        { success: false, error: '无效的批次ID' },
        { status: 400 },
      )
    }

    const batch = await getBatchById(batchId)

    if (!batch) {
      return NextResponse.json(
        { success: false, error: '批次不存在' },
        { status: 404 },
      )
    }

    // 获取日志
    const logs = await getLogsByBatch(batchId, 100)

    return NextResponse.json({
      success: true,
      data: {
        batch,
        logs,
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

// DELETE /api/batches/[id] - 删除批次
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const batchId = parseInt(id)

    if (isNaN(batchId)) {
      return NextResponse.json(
        { success: false, error: '无效的批次ID' },
        { status: 400 },
      )
    }

    const batch = await getBatchById(batchId)

    if (!batch) {
      return NextResponse.json(
        { success: false, error: '批次不存在' },
        { status: 404 },
      )
    }

    // 不允许删除正在运行的批次
    if (
      ['downloading', 'extracting', 'parsing', 'importing'].includes(
        batch.status,
      )
    ) {
      return NextResponse.json(
        { success: false, error: '不能删除正在运行的批次' },
        { status: 400 },
      )
    }

    await deleteBatch(batchId)

    return NextResponse.json({
      success: true,
      message: '批次已删除',
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
