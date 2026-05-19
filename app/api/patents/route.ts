import { NextRequest, NextResponse } from 'next/server'
import { getPatents, initializeDatabase } from '@/lib/db'

// GET /api/patents - 查询专利数据
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams

    const page = parseInt(searchParams.get('page') || '1')
    const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 100)
    const search = searchParams.get('search') || undefined
    const kind = searchParams.get('kind') || undefined
    const appType = searchParams.get('app_type') || undefined
    const batchId = searchParams.get('batch_id') || undefined
    const pubDateFrom = searchParams.get('pub_date_from') || undefined
    const pubDateTo = searchParams.get('pub_date_to') || undefined
    const province = searchParams.get('province') || undefined

    // 确保数据库表存在
    await initializeDatabase()

    const result = await getPatents(
      {
        search,
        kind,
        app_type: appType,
        batch_id: batchId,
        pub_date_from: pubDateFrom,
        pub_date_to: pubDateTo,
        province,
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
