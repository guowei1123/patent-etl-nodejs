import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutoSyncTask } from '../etl/auto-queue'

const mocks = vi.hoisted(() => ({
  claimNextAutoTask: vi.fn(),
  heartbeatAutoTask: vi.fn(),
  failAutoTask: vi.fn(),
  completeAutoTask: vi.fn(),
  cancelAutoTask: vi.fn(),
  enqueueAutoTask: vi.fn(),
  enqueueCompletedBatchCleanupTasks: vi.fn(),
  runDownloadStep: vi.fn(),
  query: vi.fn(),
  addLog: vi.fn(),
}))
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: mocks.query }), addLog: mocks.addLog }))
vi.mock('../etl/auto-queue', () => ({
  ...mocks,
  AUTO_STAGES: ['download'],
  getAutoStageLaunchLimit: () => 1,
}))
vi.mock('../etl/download-step', () => ({ runDownloadStep: mocks.runDownloadStep }))
vi.mock('../etl/process-step', () => ({ runProcessStep: vi.fn() }))
vi.mock('../etl/import-step', () => ({ runImportStep: vi.fn() }))
vi.mock('../etl/task-state', () => ({
  cancelTask: vi.fn(), getDownloadFileList: vi.fn(), getDownloadProgress: vi.fn(), getProcessProgress: vi.fn(),
}))
vi.mock('@/lib/temp-dir', () => ({
  cleanTempDir: vi.fn(), getTempBatchDirectories: () => [], getTempDirState: vi.fn(),
}))

describe('inline scheduler failure recovery', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    for (const mock of Object.values(mocks)) mock.mockReset()
    mocks.claimNextAutoTask.mockResolvedValue(null)
    mocks.heartbeatAutoTask.mockResolvedValue({ alive: true, cancelRequested: false })
    mocks.enqueueCompletedBatchCleanupTasks.mockResolvedValue([])
    mocks.failAutoTask.mockResolvedValue({ retrying: true })
    mocks.runDownloadStep.mockResolvedValue({ success: false, error: 'FTP connection closed' })
    mocks.query.mockResolvedValue({ rows: [] })
    mocks.addLog.mockResolvedValue(undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.clearAllTimers()
    delete globalThis.__patentAutoSyncScheduler
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  async function runFailure() {
    const task = { id: 1, batch_code: 'batch', stage: 'download', attempt_count: 1, max_attempts: 3 } as AutoSyncTask
    mocks.claimNextAutoTask.mockResolvedValueOnce(task)
    const { startInlineScheduler } = await import('../etl/inline-scheduler')
    startInlineScheduler()
    await vi.advanceTimersByTimeAsync(0)
    return task
  }

  it('queues a retry and resets the batch after a transfer fails', async () => {
    const task = await runFailure()
    expect(mocks.failAutoTask).toHaveBeenCalledWith(task, expect.any(String), 'FTP connection closed')
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE sync_batches'), ['batch', 'pending'])
    expect(mocks.addLog).toHaveBeenCalledWith('batch', 'warn', expect.stringContaining('30 秒后重试'))
    expect(mocks.completeAutoTask).not.toHaveBeenCalled()
  })

  it('preserves both errors when failure persistence rejects and keeps polling', async () => {
    const recoveryError = new Error('database unavailable')
    mocks.failAutoTask.mockRejectedValue(recoveryError)
    await runFailure()
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('失败处理未完成'),
      expect.objectContaining({ originalError: 'FTP connection closed', recoveryError }),
    )
    expect(mocks.query).not.toHaveBeenCalled()
    const claims = mocks.claimNextAutoTask.mock.calls.length
    await vi.advanceTimersByTimeAsync(2000)
    expect(mocks.claimNextAutoTask.mock.calls.length).toBeGreaterThan(claims)
  })

  it('leaves the batch failed when the retry limit has been reached', async () => {
    mocks.failAutoTask.mockResolvedValue({ retrying: false })
    await runFailure()
    expect(mocks.query).not.toHaveBeenCalled()
    expect(mocks.addLog).toHaveBeenCalledWith('batch', 'error', expect.stringContaining('最大重试次数'))
  })
})
