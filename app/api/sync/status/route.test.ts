import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const dbMock = vi.hoisted(() => ({
  getBatchByCode: vi.fn(),
}))

const etlMock = vi.hoisted(() => ({
  cancelTask: vi.fn(),
  getDownloadFileList: vi.fn(),
  getDownloadProgress: vi.fn(),
  getProcessProgress: vi.fn(),
  isTaskRunning: vi.fn(),
}))

vi.mock('@/lib/db', () => dbMock)
vi.mock('@/lib/etl-pipeline', () => etlMock)

describe('sync status route process progress', () => {
  beforeEach(() => {
    vi.resetModules()
    for (const mock of Object.values(dbMock)) mock.mockReset()
    for (const mock of Object.values(etlMock)) mock.mockReset()
    dbMock.getBatchByCode.mockResolvedValue({
      batch_code: 'batch-1',
      status: 'processing',
      total_files: 5,
      processed_files: 1,
      total_patents: 0,
      imported_patents: 0,
    })
    etlMock.isTaskRunning.mockReturnValue(true)
    etlMock.getDownloadProgress.mockReturnValue(null)
    etlMock.getDownloadFileList.mockReturnValue(null)
    etlMock.getProcessProgress.mockReturnValue({
      batchCode: 'batch-1',
      currentZip: 'INNER.ZIP',
      phase: 'uploading_images',
      processedZips: 0,
      totalZips: 5,
      xmlProcessed: 2000,
      patentCount: 2000,
      imageTotal: 100,
      imageUploaded: 20,
      imageSkipped: 10,
      imageFailed: 0,
      updatedAt: 1,
    })
  })

  it('returns process progress for running processing batches', async () => {
    const { GET } = await import('./route')
    const response = await GET(
      new NextRequest('http://localhost/api/sync/status?batch_code=batch-1'),
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data.process_progress).toMatchObject({
      currentZip: 'INNER.ZIP',
      phase: 'uploading_images',
      imageUploaded: 20,
      imageSkipped: 10,
    })
  })
})
