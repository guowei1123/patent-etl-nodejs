import { NextRequest, NextResponse } from 'next/server'
import { createFtpClient, isFtpConfigured } from '@/lib/ftp-client'
import {
  getCached,
  setCache,
  bustCache,
  CONNECTION_CACHE_KEY,
  CACHE_TTL,
} from '@/lib/cache'

export async function GET(request: NextRequest) {
  if (!isFtpConfigured()) {
    return NextResponse.json({ success: false, error: 'FTP 配置未设置' })
  }

  const force = request.nextUrl.searchParams.get('force') === '1'
  if (!force) {
    const cached = getCached<{ success: boolean; error?: string }>(
      CONNECTION_CACHE_KEY.ftp,
    )
    if (cached) return NextResponse.json(cached)
  }

  const client = createFtpClient()
  try {
    const result = await client.testConnection()
    setCache(CONNECTION_CACHE_KEY.ftp, result, CACHE_TTL)
    return NextResponse.json(result)
  } finally {
    await client.disconnect()
  }
}

export async function POST() {
  bustCache(CONNECTION_CACHE_KEY.ftp)
  return GET(new NextRequest(new URL('http://localhost?force=1')))
}
