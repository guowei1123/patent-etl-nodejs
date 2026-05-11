const store = new Map<string, { data: unknown; expireAt: number }>()

export function getCached<T>(key: string): T | null {
  const entry = store.get(key)
  if (!entry) return null
  if (Date.now() > entry.expireAt) {
    store.delete(key)
    return null
  }
  return entry.data as T
}

export function setCache(key: string, data: unknown, ttlMs: number) {
  store.set(key, { data, expireAt: Date.now() + ttlMs })
}

export function bustCache(key: string) {
  store.delete(key)
}

export const CONNECTION_CACHE_KEY = {
  ftp: 'connection:ftp',
  oss: 'connection:oss',
  db: 'connection:db',
}

export const CACHE_TTL = 24 * 60 * 60 * 1000 // 24h
