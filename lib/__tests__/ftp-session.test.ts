import { EventEmitter } from 'events'
import type { Client } from 'basic-ftp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeFtpSession, connectFtpSession } from '../ftp-session'

const options = { host: 'ftp.example.test', user: 'test-user' }
function client() {
  let closed = true
  const socket = new EventEmitter()
  const raw = {
    ftp: { socket },
    get closed() {
      return closed
    },
    access: vi.fn(async () => {
      closed = false
    }),
    close: vi.fn(() => {
      closed = true
      socket.emit('close')
    }),
  }
  return {
    ...raw,
    get closed() {
      return closed
    },
    asClient: raw as unknown as Client,
  }
}

describe('shared FTP session limits', () => {
  beforeEach(() => {
    delete globalThis.__patentFtpSessions
    vi.useFakeTimers()
    vi.stubEnv('FTP_MAX_CONNECTIONS', '2')
    vi.stubEnv('FTP_RETRY_ATTEMPTS', '2')
    vi.stubEnv('FTP_LOGIN_RETRY_DELAY_MS', '1000')
  })
  afterEach(() => {
    delete globalThis.__patentFtpSessions
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('queues connections for the same account and releases each slot only once', async () => {
    const [a, b, c] = [client(), client(), client()]
    await Promise.all([
      connectFtpSession(a.asClient, options),
      connectFtpSession(b.asClient, options),
    ])
    const waiting = connectFtpSession(c.asClient, options)
    await vi.advanceTimersByTimeAsync(0)
    expect(c.access).not.toHaveBeenCalled()
    closeFtpSession(a.asClient)
    closeFtpSession(a.asClient)
    await waiting
    expect(c.access).toHaveBeenCalledTimes(1)
    const account = [...globalThis.__patentFtpSessions!.accounts.values()][0]
    expect(account.active).toBe(2)
    closeFtpSession(b.asClient)
    closeFtpSession(c.asClient)
    expect(account.active).toBe(0)
  })

  it('does not block a different FTP account', async () => {
    vi.stubEnv('FTP_MAX_CONNECTIONS', '1')
    const [a, b] = [client(), client()]
    await connectFtpSession(a.asClient, options)
    await connectFtpSession(b.asClient, { ...options, user: 'another-user' })
    expect(b.access).toHaveBeenCalledTimes(1)
    closeFtpSession(a.asClient)
    closeFtpSession(b.asClient)
  })

  it('closes failed logins and releases their slot without retrying bad credentials', async () => {
    vi.stubEnv('FTP_MAX_CONNECTIONS', '1')
    const [a, b] = [client(), client()]
    a.access.mockRejectedValue(new Error('530 Login incorrect'))
    const failed = expect(
      connectFtpSession(a.asClient, options),
    ).rejects.toThrow('530')
    const waiting = connectFtpSession(b.asClient, options)
    await failed
    await waiting
    expect(a.access).toHaveBeenCalledTimes(1)
    expect(a.close).toHaveBeenCalled()
    closeFtpSession(b.asClient)
  })

  it('returns a slot when the server closes the control socket', async () => {
    vi.stubEnv('FTP_MAX_CONNECTIONS', '1')
    const [a, b] = [client(), client()]
    await connectFtpSession(a.asClient, options)
    const waiting = connectFtpSession(b.asClient, options)
    a.close()
    await waiting
    expect(b.access).toHaveBeenCalledTimes(1)
    closeFtpSession(b.asClient)
  })

  it('backs off all new logins for the account after a 421 response', async () => {
    const [a, b] = [client(), client()]
    a.access.mockRejectedValueOnce(
      new Error('421 Maximum login limit has been reached.'),
    )
    const first = connectFtpSession(a.asClient, options)
    await vi.advanceTimersByTimeAsync(0)
    const second = connectFtpSession(b.asClient, options)
    await vi.advanceTimersByTimeAsync(999)
    expect(a.access).toHaveBeenCalledTimes(1)
    expect(b.access).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await Promise.all([first, second])
    expect(a.access).toHaveBeenCalledTimes(2)
    closeFtpSession(a.asClient)
    closeFtpSession(b.asClient)
  })

  it('reports exhausted login retries and leaves no occupied sessions', async () => {
    const a = client()
    a.access.mockRejectedValue(
      new Error('421 Maximum login limit has been reached.'),
    )
    const failed = expect(
      connectFtpSession(a.asClient, options),
    ).rejects.toThrow('已有下载文件已保留')
    await vi.advanceTimersByTimeAsync(1000)
    await failed
    expect(a.access).toHaveBeenCalledTimes(2)
    expect(
      [...globalThis.__patentFtpSessions!.accounts.values()][0].active,
    ).toBe(0)
  })

  it('cancels a queued connection before it can log in later', async () => {
    vi.stubEnv('FTP_MAX_CONNECTIONS', '1')
    const [a, b] = [client(), client()]
    await connectFtpSession(a.asClient, options)
    const cancelled = expect(
      connectFtpSession(b.asClient, options),
    ).rejects.toThrow('等待已取消')
    closeFtpSession(b.asClient)
    await cancelled
    closeFtpSession(a.asClient)
    await vi.advanceTimersByTimeAsync(0)
    expect(b.access).not.toHaveBeenCalled()
  })
})
