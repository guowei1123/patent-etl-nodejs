import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'

const dbMock = vi.hoisted(() => ({
  getPatentImageById: vi.fn(),
  initializeDatabase: vi.fn(),
}))

const ossMock = vi.hoisted(() => ({
  getPatentImage: vi.fn(),
}))

vi.mock('@/lib/db', () => dbMock)
vi.mock('@/lib/oss-client', () => ossMock)

const imageId = '11111111-1111-4111-8111-111111111111'

describe('patent image proxy route', () => {
  beforeEach(() => {
    vi.resetModules()
    for (const mock of Object.values(dbMock)) mock.mockReset()
    for (const mock of Object.values(ossMock)) mock.mockReset()
    dbMock.initializeDatabase.mockResolvedValue(undefined)
  })

  it('rejects invalid image ids', async () => {
    const { GET } = await import('./route')
    const response = await GET({} as NextRequest, {
      params: Promise.resolve({ image_id: 'bad-id' }),
    })
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body).toEqual({ success: false, error: '无效的图片 ID' })
    expect(dbMock.getPatentImageById).not.toHaveBeenCalled()
  })

  it('returns 404 when metadata is missing', async () => {
    dbMock.getPatentImageById.mockResolvedValue(null)

    const { GET } = await import('./route')
    const response = await GET({} as NextRequest, {
      params: Promise.resolve({ image_id: imageId }),
    })
    const body = await response.json()

    expect(response.status).toBe(404)
    expect(body).toEqual({ success: false, error: '图片不存在' })
  })

  it('returns 404 when OSS object is missing', async () => {
    dbMock.getPatentImageById.mockResolvedValue({
      id: imageId,
      oss_key: 'patents/batch-1/100001/100001.jpg',
      content_type: 'image/jpeg',
    })
    const error = new Error('Object not exists') as Error & { status: number }
    error.status = 404
    ossMock.getPatentImage.mockRejectedValue(error)

    const { GET } = await import('./route')
    const response = await GET({} as NextRequest, {
      params: Promise.resolve({ image_id: imageId }),
    })
    const body = await response.json()

    expect(response.status).toBe(404)
    expect(body).toEqual({ success: false, error: '图片文件不存在' })
  })

  it('proxies image bytes from OSS', async () => {
    const content = Buffer.from([1, 2, 3])
    dbMock.getPatentImageById.mockResolvedValue({
      id: imageId,
      oss_key: 'patents/batch-1/100001/100001.jpg',
      content_type: 'image/jpeg',
    })
    ossMock.getPatentImage.mockResolvedValue({
      content,
      contentType: 'image/jpeg',
    })

    const { GET } = await import('./route')
    const response = await GET({} as NextRequest, {
      params: Promise.resolve({ image_id: imageId }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('image/jpeg')
    expect(response.headers.get('Content-Length')).toBe('3')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(content)
  })
})
