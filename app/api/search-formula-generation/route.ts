import { NextRequest, NextResponse } from 'next/server'
import {
  generateSearchFormula,
  type SearchFormulaOutputFormat,
} from './service'

export const dynamic = 'force-dynamic'

const OUTPUT_FORMATS = new Set<SearchFormulaOutputFormat>([
  'format1',
  'format2',
])

function normalizeStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null

  const normalized = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)

  return normalized.length > 0 ? normalized : null
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const keywords = normalizeStringArray(body.keywords)
    const ipcCodes = normalizeStringArray(body.ipcCodes)
    const outputFormat = (body.outputFormat ||
      'format1') as SearchFormulaOutputFormat

    if (!keywords) {
      return NextResponse.json(
        { success: false, error: 'keywords 必须是非空字符串数组' },
        { status: 400 },
      )
    }

    if (!ipcCodes) {
      return NextResponse.json(
        { success: false, error: 'ipcCodes 必须是非空字符串数组' },
        { status: 400 },
      )
    }

    if (!OUTPUT_FORMATS.has(outputFormat)) {
      return NextResponse.json(
        {
          success: false,
          error: "outputFormat 必须是 'format1' 或 'format2'",
        },
        { status: 400 },
      )
    }

    const result = await generateSearchFormula({
      keywords,
      ipcCodes,
      outputFormat,
    })

    return NextResponse.json({ success: true, ...result })
  } catch (error) {
    console.error('检索式生成失败:', error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : '检索式生成失败',
      },
      { status: 500 },
    )
  }
}
