import { NextRequest, NextResponse } from 'next/server'
import { testConnection, isDbConfigured } from '@/lib/db'
import {
  getCached,
  setCache,
  CONNECTION_CACHE_KEY,
  CACHE_TTL,
} from '@/lib/cache'

// GET /api/db/init - 测试数据库连接（带缓存）
export async function GET(request: NextRequest) {
  try {
    const force = request.nextUrl.searchParams.get('force') === '1'
    if (!force) {
      const cached = getCached<{
        success: boolean
        error?: string
        database_url_set: boolean
      }>(CONNECTION_CACHE_KEY.db)
      if (cached) return NextResponse.json(cached)
    }

    const result = await testConnection()
    const body = {
      success: result.success,
      error: result.error,
      database_url_set: isDbConfigured(),
    }
    setCache(CONNECTION_CACHE_KEY.db, body, CACHE_TTL)
    return NextResponse.json(body)
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : '测试失败',
      database_url_set: isDbConfigured(),
    })
  }
}

// POST /api/db/init - 强制重新测试（绕过缓存）
export async function POST() {
  return GET(new NextRequest(new URL('http://localhost?force=1')))
}
