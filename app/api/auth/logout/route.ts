import { NextResponse } from 'next/server'
import { sessionCookieOptions } from '@/lib/auth'

export async function POST() {
  const opts = sessionCookieOptions(0)
  const response = NextResponse.json({ success: true })
  response.cookies.set(opts.name, '', {
    httpOnly: opts.httpOnly,
    secure: opts.secure,
    sameSite: opts.sameSite,
    path: opts.path,
    maxAge: 0,
  })
  return response
}
