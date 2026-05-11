const COOKIE_NAME = 'patent-etl-session'

function getSecret(): string {
  return process.env.SESSION_SECRET_KEY || 'dev-secret-change-me'
}

function getCredentials(): { username: string; password: string } {
  return {
    username: process.env.AUTH_USERNAME || 'admin',
    password: process.env.AUTH_PASSWORD || '',
  }
}

async function hmacSign(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload))
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export async function createSession(
  username: string,
  password: string,
): Promise<{ token: string; maxAge: number } | null> {
  const creds = getCredentials()
  if (username !== creds.username || password !== creds.password) return null

  const expires = Math.floor(Date.now() / 1000) + 86400 // 24h
  const payload = `${username}:${expires}`
  const sig = await hmacSign(payload, getSecret())
  return { token: `${payload}.${sig}`, maxAge: 86400 }
}

export async function verifySession(token: string): Promise<boolean> {
  const [payload, sig] = token.split('.')
  if (!payload || !sig) return false

  const parts = payload.split(':')
  const expires = parseInt(parts[parts.length - 1])
  if (isNaN(expires) || expires < Math.floor(Date.now() / 1000)) return false

  const expected = await hmacSign(payload, getSecret())
  return sig === expected
}

export function sessionCookieOptions(maxAge: number) {
  return {
    name: COOKIE_NAME,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge,
  }
}

export function getCookieName() {
  return COOKIE_NAME
}
