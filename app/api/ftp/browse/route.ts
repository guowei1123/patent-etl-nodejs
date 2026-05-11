import { NextRequest, NextResponse } from 'next/server'
import { createFtpClient, isFtpConfigured } from '@/lib/ftp-client'

// GET /api/ftp/browse?path=/xxx - 浏览 FTP 目录
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams
    const ftpPath = searchParams.get('path') || '/'

    // 检查 FTP 配置
    if (!isFtpConfigured()) {
      return NextResponse.json(
        { success: false, error: 'FTP 配置未设置' },
        { status: 400 },
      )
    }

    const client = createFtpClient()

    try {
      const entries = await client.listDirectory(ftpPath)

      // 按类型和名称排序：目录在前，然后按名称排序
      entries.sort((a, b) => {
        if (a.type !== b.type) {
          return a.type === 'directory' ? -1 : 1
        }
        return a.name.localeCompare(b.name)
      })

      return NextResponse.json({
        success: true,
        data: {
          path: ftpPath,
          entries,
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
