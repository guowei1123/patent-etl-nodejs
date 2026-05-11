import { NextRequest, NextResponse } from 'next/server'
import { testOssConnection, isOssConfigured } from '@/lib/oss-client'
import {
  getCached,
  setCache,
  bustCache,
  CONNECTION_CACHE_KEY,
  CACHE_TTL,
} from '@/lib/cache'

export async function GET(request: NextRequest) {
  if (!isOssConfigured()) {
    return NextResponse.json({ success: false, error: 'OSS 配置未设置' })
  }

  const force = request.nextUrl.searchParams.get('force') === '1'
  if (!force) {
    const cached = getCached<{ success: boolean; error?: string }>(
      CONNECTION_CACHE_KEY.oss,
    )
    if (cached) return NextResponse.json(cached)
  }

  const result = await testOssConnection()
  setCache(CONNECTION_CACHE_KEY.oss, result, CACHE_TTL)
  return NextResponse.json(result)
}

export async function POST() {
  bustCache(CONNECTION_CACHE_KEY.oss)
  return GET(new NextRequest(new URL('http://localhost?force=1')))
}
