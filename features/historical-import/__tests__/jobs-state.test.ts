import { beforeEach, describe, expect, it, vi } from 'vitest'
import { emptySummary, type HistoryJob } from '../model'

const mocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  delay: vi.fn(),
}))
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  mkdir: mocks.mkdir,
  writeFile: mocks.writeFile,
  rename: mocks.rename,
}))
vi.mock('node:timers/promises', () => ({ setTimeout: mocks.delay }))
import { saveJob } from '../jobs'

beforeEach(() => {
  vi.resetAllMocks()
})

const job = {
  id: '3711bfa8-a841-400b-bea7-62200805722e',
  summary: emptySummary(),
} as HistoryJob

describe('历史导入任务状态保存', () => {
  it('状态文件短暂被占用时重试替换，保留同一份完整状态', async () => {
    mocks.rename.mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EPERM' }))
    await saveJob(job)
    expect(mocks.writeFile).toHaveBeenCalledTimes(1)
    expect(mocks.rename).toHaveBeenCalledTimes(2)
    expect(mocks.rename.mock.calls[0]).toEqual(mocks.rename.mock.calls[1])
    expect(mocks.delay).toHaveBeenCalledWith(100)
  })

  it('持续占用时在有限次重试后报告失败', async () => {
    const error = Object.assign(new Error('busy'), { code: 'EBUSY' })
    mocks.rename.mockRejectedValue(error)
    await expect(saveJob(job)).rejects.toBe(error)
    expect(mocks.rename).toHaveBeenCalledTimes(6)
    expect(mocks.delay).toHaveBeenCalledTimes(5)
  })

  it('非占用错误立即报告', async () => {
    const error = Object.assign(new Error('full'), { code: 'ENOSPC' })
    mocks.rename.mockRejectedValue(error)
    await expect(saveJob(job)).rejects.toBe(error)
    expect(mocks.rename).toHaveBeenCalledTimes(1)
    expect(mocks.delay).not.toHaveBeenCalled()
  })
})
