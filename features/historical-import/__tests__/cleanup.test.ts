import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
  end: vi.fn(),
  release: vi.fn(),
  remove: vi.fn(),
}))
vi.mock('pg', () => ({
  default: {
    Pool: class {
      query = mocks.query
      connect = mocks.connect
      end = mocks.end
    },
  },
}))
vi.mock('ali-oss', () => ({
  default: class {
    delete = mocks.remove
  },
}))
import { cleanupObjects } from '../cleanup'

const key = 'patents/history/old.png'
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv('OBJECT_STORAGE_TYPE', 'oss')
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes('to_regclass')) return { rows: [{ name: 'cleanup' }] }
    if (sql.includes('SELECT c.oss_key')) return { rows: [{ oss_key: key }] }
    return { rows: [], rowCount: 0 }
  })
  mocks.connect.mockResolvedValue({
    query: mocks.query,
    release: mocks.release,
  })
})
describe('历史图片对象清理', () => {
  it('拒绝清理未出现在当前清单的对象', async () => {
    await expect(cleanupObjects('job', ['patents/other.png'])).rejects.toThrow(
      '清理清单已变化',
    )
    expect(mocks.remove).not.toHaveBeenCalled()
  })
  it('再次发现引用时保留对象及资产记录', async () => {
    const original = mocks.query.getMockImplementation()!
    mocks.query.mockImplementation(async (sql: string) =>
      sql.includes('SELECT i.id')
        ? { rows: [{ id: 'reference' }], rowCount: 1 }
        : original(sql),
    )
    expect(await cleanupObjects('job', [key])).toBe(0)
    expect(mocks.remove).not.toHaveBeenCalled()
    expect(
      mocks.query.mock.calls.some(([sql]) => sql.startsWith('DELETE')),
    ).toBe(false)
  })
  it('存储删除失败时回滚，保留清理队列供重试', async () => {
    mocks.remove.mockRejectedValue(new Error('unavailable'))
    await expect(cleanupObjects('job', [key])).rejects.toThrow('对象清理未完成')
    expect(mocks.query).toHaveBeenCalledWith('ROLLBACK')
    expect(
      mocks.query.mock.calls.some(([sql]) => sql.startsWith('DELETE')),
    ).toBe(false)
    expect(mocks.release).toHaveBeenCalled()
  })
  it('无引用对象删除成功后清理资产并标记队列', async () => {
    expect(await cleanupObjects('job', [key])).toBe(1)
    expect(mocks.remove).toHaveBeenCalledWith(key)
    expect(mocks.query).toHaveBeenCalledWith(
      'DELETE FROM cnipa.image_asset WHERE oss_key=$1',
      [key],
    )
    expect(mocks.query).toHaveBeenCalledWith('COMMIT')
  })
})
