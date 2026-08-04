import { NextRequest, NextResponse } from 'next/server'
import { createSession, sessionCookieOptions } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const { username, password } = await request.json()

  if (!username || !password) {
    return NextResponse.json(
      { success: false, error: '请输入用户名和密码' },
      { status: 400 },
    )
  }

  const session = await createSession(username, password)
  if (!session) {
    return NextResponse.json(
      { success: false, error: '用户名或密码错误' },
      { status: 401 },
    )
  }

  const opts = sessionCookieOptions(session.maxAge)
  const response = NextResponse.json({ success: true })
  response.cookies.set(opts.name, session.token, {
    httpOnly: opts.httpOnly,
    secure: opts.secure,
    sameSite: opts.sameSite,
    path: opts.path,
    maxAge: opts.maxAge,
  })
  return response
}
