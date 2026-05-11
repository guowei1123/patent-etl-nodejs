import { NextRequest, NextResponse } from 'next/server'
import { getPatents, initializeDatabase } from '@/lib/db'
import type { PatentType } from '@/types'

// GET /api/patents - 查询专利数据
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams

    const page = parseInt(searchParams.get('page') || '1')
    const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 100)
    const search = searchParams.get('search') || undefined
    const patentType = searchParams.get('patent_type') as PatentType | null
    const batchId = searchParams.get('batch_id')
    const grantDateFrom = searchParams.get('grant_date_from') || undefined
    const grantDateTo = searchParams.get('grant_date_to') || undefined

    // 确保数据库表存在
    await initializeDatabase()

    const result = await getPatents(
      {
        search,
        patent_type: patentType || undefined,
        batch_id: batchId ? parseInt(batchId) : undefined,
        grant_date_from: grantDateFrom,
        grant_date_to: grantDateTo,
      },
      page,
      limit,
    )

    return NextResponse.json({
      success: true,
      data: result,
    })
  } catch (error) {
    console.error('查询专利失败:', error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : '查询失败',
      },
      { status: 500 },
    )
  }
}
