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

  it('does not delete local temp files when database deletion fails', async () => {
    dbMock.deleteBatch.mockRejectedValue(new Error('database unavailable'))

    const { DELETE } = await import('./route')
    const response = await DELETE({} as NextRequest, {
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
})
