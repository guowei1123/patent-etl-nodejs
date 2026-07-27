import { NextRequest, NextResponse } from 'next/server'
import { getPatentImageById, initializeDatabase } from '@/lib/db'
import { getPatentImage } from '@/lib/oss-client'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ image_id: string }> },
) {
  try {
    const { image_id: imageId } = await params

    if (!imageId) {
      return NextResponse.json(
        { success: false, error: '无效的图片 ID' },
        { status: 400 },
      )
    }

    await initializeDatabase()
    const image = await getPatentImageById(decodeURIComponent(imageId))
    if (!image) {
      return NextResponse.json(
        { success: false, error: '图片不存在' },
        { status: 404 },
      )
    }

    const result = await getPatentImage(image.oss_key)
    return new NextResponse(Uint8Array.from(result.content), {
      headers: {
        'Content-Type': result.contentType || image.content_type,
        'Cache-Control': 'private, max-age=86400',
        'Content-Length': String(result.content.length),
      },
    })
  } catch (error) {
    const status =
      error instanceof Error &&
      'status' in error &&
      (error as { status?: number }).status === 404
        ? 404
        : 500
    return NextResponse.json(
      {
        success: false,
        error: status === 404 ? '图片文件不存在' : '读取图片失败',
      },
      { status },
    )
  }
}
