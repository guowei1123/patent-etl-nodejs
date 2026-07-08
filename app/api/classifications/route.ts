import { NextRequest, NextResponse } from 'next/server'
import {
  getClassificationList,
  getClassificationSemanticList,
  getClassificationTree,
  initializeDatabase,
} from '@/lib/db'
import type { ClassificationSearchMode, ClassificationType } from '@/types'

function parsePositiveInt(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function isClassificationType(
  value: string | null,
): value is ClassificationType {
  return value === 'ipc' || value === 'cpc'
}

function getClassificationSearchMode(
  value: string | null,
): ClassificationSearchMode {
  return value === 'semantic' ? 'semantic' : 'keyword'
}

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams
    const type = searchParams.get('type')

    if (!isClassificationType(type)) {
      return NextResponse.json(
        {
          success: false,
          error: '分类类型必须是 ipc 或 cpc',
        },
        { status: 400 },
      )
    }

    const page = parsePositiveInt(searchParams.get('page'), 1)
    const limit = Math.min(parsePositiveInt(searchParams.get('limit'), 20), 100)
    const q = searchParams.get('q')?.trim() || undefined
    const view = searchParams.get('view')
    const mode = getClassificationSearchMode(searchParams.get('mode'))
    const parent = searchParams.get('parent')?.trim() || null

    if (mode === 'semantic') {
      if (type === 'cpc') {
        return NextResponse.json(
          {
            success: false,
            error: '语义搜索当前仅支持 IPC，请先生成 CPC 向量后再使用',
          },
          { status: 400 },
        )
      }

      if (!q) {
        return NextResponse.json(
          {
            success: false,
            error: '语义搜索需要输入技术描述或关键词',
          },
          { status: 400 },
        )
      }

      await initializeDatabase()

      const result = await getClassificationSemanticList(
        { type, q },
        Math.min(parsePositiveInt(searchParams.get('limit'), 20), 50),
      )

      return NextResponse.json({
        success: true,
        data: result,
      })
    }

    await initializeDatabase()

    if (view === 'tree') {
      const treeLimit = Math.min(
        parsePositiveInt(searchParams.get('limit'), 100),
        200,
      )
      const result = await getClassificationTree({ type, q }, parent, treeLimit)

      return NextResponse.json({
        success: true,
        data: result,
      })
    }

    const result = await getClassificationList({ type, q }, page, limit)

    return NextResponse.json({
      success: true,
      data: result,
    })
  } catch (error) {
    console.error('查询分类字典失败:', error)
    return NextResponse.json(
      {
        success: false,
        error: '分类字典查询失败，请检查数据库连接后重试',
      },
      { status: 500 },
    )
  }
}
