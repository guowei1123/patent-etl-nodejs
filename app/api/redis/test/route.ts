import { NextResponse } from 'next/server'
import {
  isRedisClassificationsConfigured,
  testRedisConnection,
} from '@/lib/redis-classifications'
import { getCached, setCache, CACHE_TTL } from '@/lib/cache'

const CACHE_KEY = 'connection:redis'

// GET /api/redis/test - 测试 Redis 连接（带缓存）
export async function GET() {
  try {
    const cached = getCached<{
      success: boolean
      error?: string
      configured: boolean
    }>(CACHE_KEY)
    if (cached) return NextResponse.json(cached)
  } catch {
    /* 缓存读取失败时继续走实时测试 */
  }

  const configured = isRedisClassificationsConfigured()
  const result = configured
    ? await testRedisConnection()
    : { success: false, error: '未配置 REDIS_URL 或未启用 CLASSIFICATION_STORE=redis' }
  const body = {
    success: result.success,
    error: result.error,
    configured,
  }
  try {
    setCache(CACHE_KEY, body, CACHE_TTL)
  } catch {
    /* 缓存写入失败不影响返回 */
  }
  return NextResponse.json(body)
}

// POST /api/redis/test - 强制重测（绕过缓存）
export async function POST() {
  return GET()
}
