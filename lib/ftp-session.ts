import type { AccessOptions, Client } from 'basic-ftp'

type Release = () => void
type Waiter = { start: () => void }
type Account = {
  active: number
  blockedUntil: number
  queue: Waiter[]
  timer?: ReturnType<typeof setTimeout>
}
type Pending = { controller: AbortController; promise: Promise<void> }
type SessionState = {
  accounts: Map<string, Account>
  leases: WeakMap<Client, Release>
  pending: WeakMap<Client, Pending>
}
declare global {
  var __patentFtpSessions: SessionState | undefined
}

function state(): SessionState {
  return (globalThis.__patentFtpSessions ??= {
    accounts: new Map(),
    leases: new WeakMap(),
    pending: new WeakMap(),
  })
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : fallback
}

export function getFtpConnectionLimit(): number {
  return positiveInteger(process.env.FTP_MAX_CONNECTIONS, 3)
}

function dispatch(account: Account): void {
  if (!account.queue.length) {
    if (account.timer) clearTimeout(account.timer)
    account.timer = undefined
    return
  }
  const delay = account.blockedUntil - Date.now()
  if (delay > 0) {
    account.timer ??= setTimeout(() => {
      account.timer = undefined
      dispatch(account)
    }, delay)
    return
  }
  while (account.active < getFtpConnectionLimit() && account.queue.length) {
    account.queue.shift()!.start()
  }
}

function acquire(account: Account, signal: AbortSignal): Promise<Release> {
  return new Promise((resolve, reject) => {
    const cancelled = () => {
      const index = account.queue.indexOf(waiter)
      if (index >= 0) account.queue.splice(index, 1)
      dispatch(account)
      reject(new Error('FTP 连接等待已取消'))
    }
    const waiter: Waiter = {
      start: () => {
        signal.removeEventListener('abort', cancelled)
        account.active += 1
        let released = false
        resolve(() => {
          if (released) return
          released = true
          account.active -= 1
          dispatch(account)
        })
      },
    }
    if (signal.aborted) {
      cancelled()
      return
    }
    signal.addEventListener('abort', cancelled, { once: true })
    account.queue.push(waiter)
    dispatch(account)
  })
}

function isLoginLimit(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const code = (error as { code?: number } | null)?.code
  return (
    (code === 421 || /\b421\b/.test(message)) &&
    /login limit|too many (users|connections)|maximum.*(users|connections)/i.test(
      message,
    )
  )
}

// 下载池、目录浏览和连接测试共用同一账号的连接额度，开发热更新也不重置额度。
export async function connectFtpSession(
  client: Client,
  options: AccessOptions,
): Promise<void> {
  const sessions = state()
  const existing = sessions.pending.get(client)
  if (existing) return existing.promise
  if (sessions.leases.has(client) && !client.closed) return
  sessions.leases.get(client)?.()
  sessions.leases.delete(client)
  const key = JSON.stringify([
    (options.host || 'localhost').toLowerCase(),
    options.port || 21,
    options.user || 'anonymous',
  ])
  let account = sessions.accounts.get(key)
  if (!account) {
    account = { active: 0, blockedUntil: 0, queue: [] }
    sessions.accounts.set(key, account)
  }
  const accountState = account
  const controller = new AbortController()
  const pending: Pending = { controller, promise: Promise.resolve() }
  pending.promise = (async () => {
    const attempts = positiveInteger(process.env.FTP_RETRY_ATTEMPTS, 3)
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const release = await acquire(accountState, controller.signal)
      try {
        controller.signal.throwIfAborted()
        await client.access(options)
        controller.signal.throwIfAborted()
        sessions.leases.set(client, release)
        client.ftp.socket?.once('close', () => {
          if (sessions.leases.get(client) === release)
            sessions.leases.delete(client)
          release()
        })
        return
      } catch (error) {
        const limited = isLoginLimit(error)
        if (limited) {
          accountState.blockedUntil = Math.max(
            accountState.blockedUntil,
            Date.now() +
              positiveInteger(process.env.FTP_LOGIN_RETRY_DELAY_MS, 30000),
          )
        }
        try {
          client.close()
        } finally {
          release()
        }
        if (!limited || controller.signal.aborted) throw error
        if (attempt === attempts) {
          throw new Error(
            'FTP 同时登录连接数已达服务器上限（421），已等待重试。请减少同账号的其他下载连接，稍后重试；已有下载文件已保留',
            { cause: error },
          )
        }
      }
    }
  })().finally(() => {
    if (sessions.pending.get(client) === pending)
      sessions.pending.delete(client)
  })
  sessions.pending.set(client, pending)
  return pending.promise
}

export function closeFtpSession(client: Client): void {
  const sessions = state()
  sessions.pending.get(client)?.controller.abort()
  try {
    client.close()
  } finally {
    sessions.leases.get(client)?.()
    sessions.leases.delete(client)
  }
}
