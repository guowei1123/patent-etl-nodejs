import { NextRequest, NextResponse } from 'next/server'
import { verifySession, getCookieName } from '@/lib/auth'

const PUBLIC_PATHS = ['/login', '/api/auth/login', '/api/auth/logout']

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  // 静态资源跳过
  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/icon') ||
    pathname.startsWith('/apple') ||
    pathname.startsWith('/placeholder') ||
    pathname.endsWith('.ico') ||
    pathname.endsWith('.svg') ||
    pathname.endsWith('.png') ||
    pathname.endsWith('.jpg')
  ) {
    return NextResponse.next()
  }

  // 公开路径跳过
  if (
    PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'))
  ) {
    return NextResponse.next()
  }

  // 检查 session cookie
  const token = request.cookies.get(getCookieName())?.value
  if (token && (await verifySession(token))) {
    return NextResponse.next()
  }

  // 未登录，重定向到登录页（API 返回 401）
  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      { success: false, error: '未登录' },
      { status: 401 },
    )
  }

  const loginUrl = request.nextUrl.clone()
  loginUrl.pathname = '/login'
  return NextResponse.redirect(loginUrl)
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
