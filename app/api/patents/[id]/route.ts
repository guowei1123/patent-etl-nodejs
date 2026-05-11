import { NextRequest, NextResponse } from 'next/server'
import { getPatentById } from '@/lib/db'

// GET /api/patents/[id] - 获取专利详情
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const patentId = parseInt(id)

    if (isNaN(patentId)) {
      return NextResponse.json(
        { success: false, error: '无效的专利ID' },
        { status: 400 },
      )
    }

    const patent = await getPatentById(patentId)

    if (!patent) {
      return NextResponse.json(
        { success: false, error: '专利不存在' },
        { status: 404 },
      )
    }

    return NextResponse.json({
      success: true,
      data: patent,
    })
  } catch (error) {
    console.error('获取专利详情失败:', error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : '获取失败',
      },
      { status: 500 },
    )
  }
}
