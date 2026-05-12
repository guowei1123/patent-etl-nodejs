import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase, getBatchByCode, addLog } from '@/lib/db'
import { isTaskRunning } from '@/lib/etl-pipeline'
import { getTempPath } from '@/lib/file-processor'
import {
  verifyDownloadedArchive,
  verifyExtractedFilesCrc,
  formatIntegrityReport,
} from '@/lib/integrity'
import * as path from 'path'

type VerifyType = 'download' | 'extract'

// POST /api/sync/verify - 手动触发完整性校验
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { batch_code, type } = body as {
      batch_code: string
      type: VerifyType
    }

    if (!batch_code || !type) {
      return NextResponse.json(
        { success: false, error: '缺少 batch_code 或 type 参数' },
        { status: 400 },
      )
    }

    if (!['download', 'extract'].includes(type)) {
      return NextResponse.json(
        {
          success: false,
          error: `无效的校验类型: ${type}，可选: download, extract`,
        },
        { status: 400 },
      )
    }

    await initializeDatabase()

    const batch = await getBatchByCode(batch_code)
    if (!batch) {
      return NextResponse.json(
        { success: false, error: '批次不存在' },
        { status: 404 },
      )
    }

    if (isTaskRunning(batch_code)) {
      return NextResponse.json(
        { success: false, error: '该批次已有任务在运行中，无法执行校验' },
        { status: 409 },
      )
    }

    const tempPath = getTempPath(batch_code)

    if (type === 'download') {
      const result = await verifyDownloadedArchive(tempPath)
      await addLog(
        batch_code,
        result.passed ? 'info' : 'error',
        result.passed
          ? `[手动校验] 下载文件完整性通过: ${result.checkedFiles} 个文件`
          : `[手动校验] 下载文件完整性失败: ${result.failures.length} 个问题`,
        result.passed ? undefined : { failures: result.failures },
      )
      return NextResponse.json({
        success: true,
        data: {
          type: 'download',
          passed: result.passed,
          checkedFiles: result.checkedFiles,
          failures: result.failures,
          report: formatIntegrityReport(result),
        },
      })
    }

    // extract 校验
    const extractDir = path.join(tempPath, 'extracted')
    const result = await verifyExtractedFilesCrc(extractDir)
    await addLog(
      batch_code,
      result.passed ? 'info' : 'error',
      result.passed
        ? `[手动校验] 解压文件 CRC 通过: ${result.checkedFiles} 个文件`
        : `[手动校验] 解压文件 CRC 失败: ${result.failures.length} 个问题`,
      result.passed ? undefined : { failures: result.failures },
    )
    return NextResponse.json({
      success: true,
      data: {
        type: 'extract',
        passed: result.passed,
        checkedFiles: result.checkedFiles,
        failures: result.failures,
        report: formatIntegrityReport(result),
      },
    })
  } catch (error) {
    console.error('校验失败:', error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : '校验失败',
      },
      { status: 500 },
    )
  }
}
