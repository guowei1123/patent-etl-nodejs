import { beforeEach, describe, expect, it, vi } from 'vitest'

const ossMock = vi.hoisted(() => ({
  get: vi.fn(),
  head: vi.fn(),
  list: vi.fn(),
  put: vi.fn(),
}))

vi.mock('ali-oss', () => ({
  default: vi.fn(function OSS() {
    return ossMock
  }),
}))

describe('oss client patent images', () => {
  beforeEach(() => {
    vi.resetModules()
    for (const mock of Object.values(ossMock)) mock.mockReset()
    process.env.CNIPA_OSS_ACCESS_KEY_ID = 'id'
    process.env.CNIPA_OSS_ACCESS_KEY_SECRET = 'secret'
    process.env.CNIPA_OSS_BUCKET_NAME = 'bucket'
    process.env.IMAGE_UPLOAD_TIMEOUT_MS = '10'
  })

  it('checks whether a patent image exists', async () => {
    ossMock.head.mockResolvedValue({ status: 200 })

    const { patentImageExists } = await import('../oss-client')
    await expect(patentImageExists('key.jpg')).resolves.toBe(true)
  })

  it('returns false when OSS reports a missing image', async () => {
    const error = new Error('missing') as Error & { status: number }
    error.status = 404
    ossMock.head.mockRejectedValue(error)

    const { patentImageExists } = await import('../oss-client')
    await expect(patentImageExists('key.jpg')).resolves.toBe(false)
  })

  it('times out slow patent image uploads', async () => {
    ossMock.put.mockImplementation(() => new Promise(() => {}))

    const { putPatentImage } = await import('../oss-client')
    await expect(
      putPatentImage('key.jpg', Buffer.from('image'), 'image/jpeg'),
    ).rejects.toThrow('OSS 图片上传超时: key.jpg')
  })
})
