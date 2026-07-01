import { NextResponse } from 'next/server'
import {
  getDashboardStats,
  initializeDatabase,
  isDbConfigured,
  testConnection,
} from '@/lib/db'
import { isFtpConfigured } from '@/lib/ftp-client'
import { isOssConfigured } from '@/lib/oss-client'

// GET /api/stats - 获取仪表盘统计数据
export async function GET() {
  try {
    // 测试数据库连接
    const dbTest = await testConnection()

    if (!dbTest.success) {
      return NextResponse.json({
        success: false,
        error: '数据库连接失败',
        details: dbTest.error,
        data: {
          database_connected: isDbConfigured(),
          ftp_configured: isFtpConfigured(),
          oss_configured: isOssConfigured(),
          total_batches: 0,
          total_patents: 0,
          invention_patents: 0,
          utility_model_patents: 0,
          this_week_patents: 0,
          last_sync_at: null,
          pending_batches: 0,
          failed_batches: 0,
        },
      })
    }

    // 确保数据库表存在
    await initializeDatabase()

    const stats = await getDashboardStats()

    return NextResponse.json({
      success: true,
      data: {
        ...stats,
        database_connected: isDbConfigured(),
        ftp_configured: isFtpConfigured(),
        oss_configured: isOssConfigured(),
      },
    })
  } catch (error) {
    console.error('获取统计数据失败:', error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : '获取失败',
        data: {
          database_connected: isDbConfigured(),
          ftp_configured: isFtpConfigured(),
          oss_configured: isOssConfigured(),
          total_batches: 0,
          total_patents: 0,
          invention_patents: 0,
          utility_model_patents: 0,
          this_week_patents: 0,
          last_sync_at: null,
          pending_batches: 0,
          failed_batches: 0,
        },
      },
      { status: 500 },
    )
  }
}
