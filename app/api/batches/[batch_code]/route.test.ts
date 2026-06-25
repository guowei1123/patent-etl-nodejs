import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'

const dbMock = vi.hoisted(() => ({
  deleteBatch: vi.fn(),
  getBatchByCode: vi.fn(),
  getLogsByBatch: vi.fn(),
}))

const fileMock = vi.hoisted(() => ({
  cleanTempDir: vi.fn(),
  getTempDirState: vi.fn(),
}))

vi.mock('@/lib/db', () => dbMock)
vi.mock('@/lib/temp-dir', () => fileMock)

function request(body: unknown): NextRequest {
  return {
    json: vi.fn().mockResolvedValue(body),
  } as unknown as NextRequest
}

describe('batch DELETE route cleanup ordering', () => {
  beforeEach(() => {
    vi.resetModules()
    for (const mock of Object.values(dbMock)) mock.mockReset()
    for (const mock of Object.values(fileMock)) mock.mockReset()

    dbMock.getBatchByCode.mockResolvedValue({
      batch_code: 'batch-1',
      status: 'completed',
    })
    fileMock.getTempDirState.mockReturnValue({
      path: '/tmp/batch-1',
      exists: true,
      hasFiles: true,
    })
  })

  it('requires the batch code confirmation before deleting', async () => {
    const { DELETE } = await import('./route')
    const response = await DELETE(request({ confirm_batch_code: 'wrong' }), {
      params: Promise.resolve({ batch_code: 'batch-1' }),
    })
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body).toEqual({
      success: false,
      error: '请输入正确的批次编号后再删除',
    })
    expect(dbMock.getBatchByCode).not.toHaveBeenCalled()
    expect(dbMock.deleteBatch).not.toHaveBeenCalled()
    expect(fileMock.cleanTempDir).not.toHaveBeenCalled()
  })

  it('does not delete local temp files when database deletion fails', async () => {
    dbMock.deleteBatch.mockRejectedValue(new Error('database unavailable'))

    const { DELETE } = await import('./route')
    const response = await DELETE(request({ confirm_batch_code: 'batch-1' }), {
      params: Promise.resolve({ batch_code: 'batch-1' }),
    })
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body).toEqual({
      success: false,
      error: 'database unavailable',
    })
    expect(fileMock.getTempDirState).toHaveBeenCalledWith('batch-1')
    expect(fileMock.cleanTempDir).not.toHaveBeenCalled()
  })

  it('returns the deleted patent count after deleting the database and local files', async () => {
    dbMock.deleteBatch.mockResolvedValue({ deletedPatents: 12 })

    const { DELETE } = await import('./route')
    const response = await DELETE(request({ confirm_batch_code: 'batch-1' }), {
      params: Promise.resolve({ batch_code: 'batch-1' }),
    })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.data.deletedPatents).toBe(12)
    expect(dbMock.deleteBatch).toHaveBeenCalledWith('batch-1')
    expect(fileMock.cleanTempDir).toHaveBeenCalledWith('batch-1')
  })
})
