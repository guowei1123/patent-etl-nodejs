import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutoSyncTask } from '../etl/auto-queue'

const dbMock = vi.hoisted(() => ({ getPool: vi.fn() }))
vi.mock('@/lib/db', () => dbMock)

describe('automatic queue retry limits', () => {
  afterEach(() => vi.unstubAllEnvs())
  beforeEach(() => {
    vi.resetModules()
    dbMock.getPool.mockReset()
  })

  it.each([
    { value: '1', expected: 1 },
    { value: '4', expected: 4 },
    { value: '9', expected: 5 },
    { value: '0', expected: 3 },
    { value: 'invalid', expected: 3 },
  ])('uses the configured automatic download limit for $value', async ({ value, expected }) => {
    vi.stubEnv('AUTO_DOWNLOAD_BATCH_LIMIT', value)
    vi.stubEnv('DOWNLOAD_BATCH_LIMIT', '5')
    const { getAutoStageLimit } = await import('../etl/auto-queue')
    expect(getAutoStageLimit('download')).toBe(expected)
    expect(getAutoStageLimit('process')).toBe(2)
  })

  it('uses configured stage limits and bounds automatic downloads by the total', async () => {
    vi.stubEnv('AUTO_DOWNLOAD_BATCH_LIMIT', '4')
    vi.stubEnv('DOWNLOAD_BATCH_LIMIT', '2')
    vi.stubEnv('PROCESS_BATCH_LIMIT', '3')
    vi.stubEnv('IMPORT_BATCH_LIMIT', '2')
    vi.stubEnv('CLEANUP_BATCH_LIMIT', 'invalid')
    const { getAutoStageLimit, getAutoStageLaunchLimit } = await import('../etl/auto-queue')
    expect(getAutoStageLimit('download')).toBe(2)
    expect(getAutoStageLaunchLimit('download')).toBe(2)
    expect(getAutoStageLaunchLimit('process')).toBe(3)
    expect(getAutoStageLaunchLimit('import')).toBe(2)
    expect(getAutoStageLaunchLimit('cleanup')).toBe(1)
  })

  it('does not claim a stage task when its configured limit is reached', async () => {
    vi.stubEnv('PROCESS_BATCH_LIMIT', '2')
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ acquired: true }] }
        if (sql.includes('SELECT COUNT(*)')) return { rows: [{ count: '2' }] }
        return { rows: [] }
      }),
      release: vi.fn(),
    }
    dbMock.getPool.mockReturnValue({ connect: vi.fn().mockResolvedValue(client) })
    const { claimNextAutoTask } = await import('../etl/auto-queue')
    expect(await claimNextAutoTask('process', 'worker')).toBeNull()
    expect(client.query.mock.calls.some(([sql]) => sql.includes('WITH candidate'))).toBe(false)
  })

  it.each([
    { attempt: 1, status: 'queued', retrying: true },
    { attempt: 3, status: 'failed', retrying: false },
  ])('writes $status with consistent parameter types after attempt $attempt', async ({ attempt, status, retrying }) => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 })
    dbMock.getPool.mockReturnValue({ query })
    const { failAutoTask } = await import('../etl/auto-queue')
    const task = { id: 7, attempt_count: attempt, max_attempts: 3 } as AutoSyncTask
    expect(await failAutoTask(task, 'worker', 'FTP connection closed')).toEqual({ retrying })
    const [sql, parameters] = query.mock.calls[0]
    expect(sql.match(/\$3::varchar/g)).toHaveLength(3)
    expect(parameters).toEqual([7, 'worker', status, 'FTP connection closed'])
  })

  it('does not retry a task whose lease is no longer owned by the worker', async () => {
    dbMock.getPool.mockReturnValue({ query: vi.fn().mockResolvedValue({ rowCount: 0 }) })
    const { failAutoTask } = await import('../etl/auto-queue')
    expect(await failAutoTask({ id: 7, attempt_count: 1, max_attempts: 3 } as AutoSyncTask, 'old-worker', 'FTP error')).toEqual({ retrying: false })
  })

  it('allows an explicit retry to reset an exhausted queued record without resetting a running attempt', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 1, status: 'queued', attempt_count: 0 }] })
    dbMock.getPool.mockReturnValue({ query })
    const { enqueueAutoTask } = await import('../etl/auto-queue')
    expect(await enqueueAutoTask('batch', 'download', { manualOverride: true })).toMatchObject({ attempt_count: 0 })
    const [sql, parameters] = query.mock.calls[0]
    expect(sql).toContain("auto_sync_tasks.status = 'queued' AND auto_sync_tasks.attempt_count >= auto_sync_tasks.max_attempts")
    expect(sql).toContain('THEN 0')
    expect(sql).not.toContain("auto_sync_tasks.status = 'running' AND")
    expect(parameters).toEqual(['batch', 'download', 1, 0, true])
  })

  it('does not advertise exhausted queued tasks as active but allows the final running attempt', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    dbMock.getPool.mockReturnValue({ query })
    const { getActiveAutoTask } = await import('../etl/auto-queue')
    expect(await getActiveAutoTask('batch')).toBeNull()
    const [sql, parameters] = query.mock.calls[0]
    expect(sql).toContain("status IN ('queued', 'running')")
    expect(sql).toContain("status = 'running' OR attempt_count < max_attempts")
    expect(parameters[0]).toBe('batch')
  })

  it('terminates exhausted or cancelled expired leases before claiming a task under the retry limit', async () => {
    const claimed = {
      id: 1,
      batch_code: 'batch',
      stage: 'download',
      attempt_count: 3,
      max_attempts: 3,
    }
    const statements: string[] = []
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql)
        if (sql.includes('pg_try_advisory_xact_lock'))
          return { rows: [{ acquired: true }] }
        if (sql.includes('SELECT COUNT(*)')) return { rows: [{ count: '0' }] }
        if (sql.includes('WITH candidate')) return { rows: [claimed] }
        return { rows: [] }
      }),
      release: vi.fn(),
    }
    dbMock.getPool.mockReturnValue({
      connect: vi.fn().mockResolvedValue(client),
    })
    const { claimNextAutoTask } = await import('../etl/auto-queue')
    expect(await claimNextAutoTask('download', 'worker')).toEqual(claimed)
    const reap = statements.find((sql) =>
      sql.includes("WHEN cancel_requested THEN 'cancelled'"),
    )!
    expect(reap).toContain("WHEN attempt_count >= max_attempts THEN 'failed'")
    expect(reap).toContain(
      "status = 'queued' AND attempt_count >= max_attempts",
    )
    const claim = statements.find((sql) => sql.includes('WITH candidate'))!
    expect(claim).toContain('AND attempt_count < max_attempts')
    expect(statements.indexOf(reap)).toBeLessThan(statements.indexOf(claim))
    expect(statements.at(-1)).toBe('COMMIT')
    expect(client.release).toHaveBeenCalledTimes(1)
  })
})
