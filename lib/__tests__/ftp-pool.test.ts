import type { FtpEntry } from '@/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FtpConnectionPool } from '../ftp-client'

const state = vi.hoisted(() => ({
  active: 0,
  peak: 0,
  transfer: vi.fn(),
  login: vi.fn(),
}))
vi.mock('fs', () => ({
  existsSync: () => true,
  mkdirSync: vi.fn(),
  statSync: () => ({ size: 1 }),
  unlinkSync: vi.fn(),
}))
vi.mock('basic-ftp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('basic-ftp')>()
  const { EventEmitter } = await import('events')
  return {
    ...actual,
    Client: vi.fn().mockImplementation(function () {
      const raw = {
        closed: true,
        ftp: { verbose: false, socket: new EventEmitter() },
        access: vi.fn(async () => {
          await state.login()
          raw.closed = false
          state.active += 1
          state.peak = Math.max(state.peak, state.active)
        }),
        close: vi.fn(() => {
          if (!raw.closed) state.active -= 1
          raw.closed = true
          raw.ftp.socket.emit('close')
        }),
        downloadTo: vi.fn((...args: unknown[]) => state.transfer(...args)),
        trackProgress: vi.fn(),
      }
      return raw
    }),
  }
})

function files(prefix: string): FtpEntry[] {
  return ['z01', 'zip'].map((ext) => ({
    name: `${prefix}.${ext}`,
    path: `/${prefix}.${ext}`,
    type: 'file',
    size: 4,
    modifiedAt: null,
  }))
}

describe('FTP pools share connection capacity', () => {
  beforeEach(() => {
    delete globalThis.__patentFtpSessions
    state.active = 0
    state.peak = 0
    state.transfer.mockReset().mockResolvedValue(undefined)
    state.login.mockReset().mockResolvedValue(undefined)
    vi.stubEnv('FTP_MAX_CONNECTIONS', '2')
    vi.stubEnv('FTP_RETRY_ATTEMPTS', '1')
  })
  afterEach(() => {
    delete globalThis.__patentFtpSessions
    vi.unstubAllEnvs()
  })

  it('finishes concurrent pools without reserving all slots or exceeding the account limit', async () => {
    const config = { host: 'ftp.example.test', user: 'pool-user' }
    const a = new FtpConnectionPool(config, 2)
    const b = new FtpConnectionPool(config, 2)
    await Promise.all([a.connect(), b.connect()])
    expect(state.active).toBe(2)
    const results = await Promise.all([
      a.downloadFiles(files('a'), '/virtual-a', { resume: true }),
      b.downloadFiles(files('b'), '/virtual-b', { resume: true }),
    ])
    expect(results.map((result) => result.totalProcessed)).toEqual([2, 2])
    expect(state.peak).toBe(2)
    expect(state.active).toBe(0)
    expect(state.transfer.mock.calls.every((args) => args[2] === 1)).toBe(true)
  })

  it('closes all workers and drains waiting logins after a transfer failure', async () => {
    const pool = new FtpConnectionPool({ host: 'ftp.example.test' }, 2)
    await pool.connect()
    state.transfer.mockRejectedValueOnce(new Error('transfer aborted'))
    await expect(
      pool.downloadFiles(files('a'), '/virtual-a', { resume: true }),
    ).rejects.toThrow('transfer aborted')
    expect(state.active).toBe(0)
    expect(
      [...globalThis.__patentFtpSessions!.accounts.values()][0].queue,
    ).toHaveLength(0)
  })

  it('cleans up a failed initial login and caps oversized per-batch concurrency', async () => {
    state.login.mockRejectedValueOnce(new Error('530 Login incorrect'))
    const pool = new FtpConnectionPool({ host: 'ftp.example.test' }, 20)
    expect(pool.getConcurrency()).toBe(2)
    await expect(pool.connect()).rejects.toThrow('530')
    expect(state.active).toBe(0)
    expect(
      [...globalThis.__patentFtpSessions!.accounts.values()][0].active,
    ).toBe(0)
  })
})
