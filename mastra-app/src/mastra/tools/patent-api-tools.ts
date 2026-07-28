import { createTool } from '@mastra/core/tools'
import { z } from 'zod'

const API_BASE = process.env.PATENT_API_URL || 'http://localhost:3000'
const AUTH_USERNAME = process.env.PATENT_API_USERNAME || process.env.AUTH_USERNAME || 'admin'
const AUTH_PASSWORD = process.env.PATENT_API_PASSWORD || process.env.AUTH_PASSWORD || ''

let sessionCookie: string | null = null
let cookieExpiresAt: number = 0

async function ensureAuth() {
  const now = Date.now()
  
  if (sessionCookie && now < cookieExpiresAt - 60000) {
    return
  }

  const res = await fetch(`${API_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: AUTH_USERNAME, password: AUTH_PASSWORD }),
  })

  if (!res.ok) {
    throw new Error(`认证失败: ${res.status}`)
  }

  const data = await res.json()
  if (!data.success) {
    throw new Error(`登录失败: ${data.error || '用户名或密码错误'}`)
  }

  const cookieHeader = res.headers.get('set-cookie') || ''
  const match = cookieHeader.match(/patent-etl-session=([^;]+)/)
  if (!match) {
    throw new Error('登录成功但未获取到 session cookie')
  }

  sessionCookie = match[1]
  cookieExpiresAt = now + 86400000
}

async function apiFetch(path: string, params?: Record<string, string>, retry = true) {
  await ensureAuth()

  const url = new URL(path, API_BASE)
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') url.searchParams.set(key, value)
    }
  }

  const res = await fetch(url.toString(), {
    headers: {
      Cookie: `patent-etl-session=${sessionCookie}`,
    },
  })

  if (res.status === 401 && retry) {
    sessionCookie = null
    await ensureAuth()
    return apiFetch(path, params, false)
  }

  if (!res.ok) throw new Error(`请求失败 (${res.status})`)
  
  const data = await res.json()
  if (!data.success) throw new Error(data.error || 'API 返回错误')
  return data.data
}

export const searchPatentsTool = createTool({
  id: 'search_patents',
  description: '搜索专利数据，支持关键词、检索式、类型、日期范围、省份等条件',
  inputSchema: z.object({
    search: z.string().optional().describe('关键词'),
    expression: z.string().optional().describe('结构化检索式'),
    kind: z.enum(['B', 'U']).optional().describe('B=发明专利, U=实用新型'),
    page: z.number().int().min(1).default(1).describe('页码'),
    limit: z.number().int().min(1).max(100).default(20).describe('每页数量'),
    pub_date_from: z.string().optional().describe('公开日期起始 YYYY-MM-DD'),
    pub_date_to: z.string().optional().describe('公开日期截止 YYYY-MM-DD'),
    province: z.string().optional().describe('省份'),
  }),
  execute: async ({ search, expression, kind, page, limit, pub_date_from, pub_date_to, province }) => {
    const p: Record<string, string> = { page: String(page || 1), limit: String(limit || 20) }
    if (search) p.search = search
    if (expression) p.expression = expression
    if (kind) p.kind = kind
    if (pub_date_from) p.pub_date_from = pub_date_from
    if (pub_date_to) p.pub_date_to = pub_date_to
    if (province) p.province = province
    return apiFetch('/api/patents', p)
  },
})

export const patentApiTools = { searchPatentsTool }
