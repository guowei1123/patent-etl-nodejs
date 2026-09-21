import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const dbMock = vi.hoisted(() => ({
  getBatchByCode: vi.fn(),
  initializeDatabase: vi.fn(),
}))

const queueMock = vi.hoisted(() => ({
  enqueueAutoTask: vi.fn(),
  getActiveAutoTask: vi.fn(),
}))

const schedulerMock = vi.hoisted(() => ({
  startInlineScheduler: vi.fn(),
  wakeInlineScheduler: vi.fn(),
}))

vi.mock('@/lib/db', () => dbMock)
vi.mock('@/lib/etl/auto-queue', () => queueMock)
vi.mock('@/lib/etl/inline-scheduler', () => schedulerMock)

describe('manual download route', () => {
  beforeEach(() => {
    vi.resetModules()
    for (const mock of Object.values(dbMock)) mock.mockReset()
    for (const mock of Object.values(queueMock)) mock.mockReset()
    for (const mock of Object.values(schedulerMock)) mock.mockReset()
    dbMock.getBatchByCode.mockResolvedValue({
      batch_code: 'batch-1',
      status: 'pending',
    })
    queueMock.getActiveAutoTask.mockResolvedValue({
      stage: 'download',
      status: 'queued',
    })
    queueMock.enqueueAutoTask.mockResolvedValue({ id: 1 })
  })

  it('marks a queued download as a manual overflow task', async () => {
    const { POST } = await import('./route')
    const response = await POST(
      new NextRequest('http://localhost/api/sync/manual-download', {
        method: 'POST',
        body: JSON.stringify({ batch_code: 'batch-1' }),
      }),
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.success).toBe(true)
    expect(queueMock.enqueueAutoTask).toHaveBeenCalledWith(
      'batch-1',
      'download',
      { priority: 100, manualOverride: true },
    )
    expect(schedulerMock.wakeInlineScheduler).toHaveBeenCalledOnce()
  })

  it('rejects a batch that is already downloading', async () => {
    dbMock.getBatchByCode.mockResolvedValue({
      batch_code: 'batch-1',
      status: 'downloading',
    })
    const { POST } = await import('./route')
    const response = await POST(
      new NextRequest('http://localhost/api/sync/manual-download', {
        method: 'POST',
        body: JSON.stringify({ batch_code: 'batch-1' }),
      }),
    )

    expect(response.status).toBe(409)
    expect(queueMock.enqueueAutoTask).not.toHaveBeenCalled()
  })
})
