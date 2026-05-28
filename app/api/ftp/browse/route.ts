import { NextRequest, NextResponse } from 'next/server'
import { createFtpClient, isFtpConfigured } from '@/lib/ftp-client'
import { bustCache, getCacheEntry, setCache } from '@/lib/cache'
import type { FtpEntry } from '@/types'

const FTP_BROWSE_CACHE_TTL = parseInt(
  process.env.FTP_BROWSE_CACHE_TTL_MS || String(3 * 24 * 60 * 60 * 1000),
)

interface FtpBrowseCacheData {
  entries: FtpEntry[]
  cachedAt: number
}

function getFtpBrowseCacheKey(ftpPath: string): string {
  const host = process.env.CNIPA_FTP_HOST || process.env.FTP_HOST || ''
  return `ftp:browse:${host}:${ftpPath}`
}

function sortEntries(entries: FtpEntry[]): FtpEntry[] {
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'directory' ? -1 : 1
    }
    return a.name.localeCompare(b.name)
  })
}

// GET /api/ftp/browse?path=/xxx - 浏览 FTP 目录
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams
    const ftpPath = searchParams.get('path') || '/'
    const refresh = searchParams.get('refresh') === 'true'
    const cacheKey = getFtpBrowseCacheKey(ftpPath)

    // 检查 FTP 配置
    if (!isFtpConfigured()) {
      return NextResponse.json(
        { success: false, error: 'FTP 配置未设置' },
        { status: 400 },
      )
    }

    if (refresh) {
      bustCache(cacheKey)
    } else {
      const cached = getCacheEntry<FtpBrowseCacheData>(cacheKey)
      if (cached) {
        return NextResponse.json({
          success: true,
          data: {
            path: ftpPath,
            entries: cached.data.entries,
            cached: true,
            cachedAt: cached.data.cachedAt,
            expiresAt: cached.expireAt,
          },
        })
      }
    }

    const client = createFtpClient()

    try {
      const entries = sortEntries(await client.listDirectory(ftpPath))
      const cachedAt = Date.now()
      setCache(cacheKey, { entries, cachedAt }, FTP_BROWSE_CACHE_TTL)

      return NextResponse.json({
        success: true,
        data: {
          path: ftpPath,
          entries,
          cached: false,
          cachedAt,
          expiresAt: cachedAt + FTP_BROWSE_CACHE_TTL,
        },
      })
    } finally {
      await client.disconnect()
    }
  } catch (error) {
    console.error('浏览 FTP 目录失败:', error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : '浏览失败',
      },
      { status: 500 },
    )
  }
}

// POST /api/ftp/browse - 测试 FTP 连接
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { host, port, user, password, secure } = body

    // 使用提供的配置或环境变量
    const client = createFtpClient({
      host: host || process.env.CNIPA_FTP_HOST || process.env.FTP_HOST,
      port:
        port ||
        parseInt(process.env.CNIPA_FTP_PORT || process.env.FTP_PORT || '21'),
      user: user || process.env.CNIPA_FTP_USER || process.env.FTP_USER,
      password:
        password || process.env.CNIPA_FTP_PASSWORD || process.env.FTP_PASSWORD,
      secure:
        secure ??
        (process.env.CNIPA_FTP_SECURE === 'true' ||
          process.env.FTP_SECURE === 'true'),
    })

    const result = await client.testConnection()

    if (result.success) {
      return NextResponse.json({
        success: true,
        message: 'FTP 连接成功',
      })
    } else {
      return NextResponse.json({
        success: false,
        error: result.error || '连接失败',
      })
    }
  } catch (error) {
    console.error('测试 FTP 连接失败:', error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : '连接失败',
      },
      { status: 500 },
    )
  }
}
