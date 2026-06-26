'use client'

import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Spinner } from '@/components/ui/spinner'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { ThemeToggle } from '@/components/layout/theme-toggle'
import { FolderSync } from 'lucide-react'
import { toast } from 'sonner'

export default function LoginPage() {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!username || !password) {
      toast.error('请输入用户名和密码')
      return
    }

    setLoading(true)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      const data = await res.json()

      if (data.success) {
        router.push('/')
        router.refresh()
      } else {
        toast.error(data.error || '登录失败')
      }
    } catch {
      toast.error('登录请求失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="bg-background relative flex min-h-screen items-center justify-center overflow-hidden px-4">
      <div className="border-primary/20 bg-card/60 absolute top-10 left-10 hidden h-40 w-64 rounded-lg border p-3 shadow-xs lg:block">
        <div className="grid h-full grid-cols-4 gap-2">
          {[...Array(12)].map((_, index) => (
            <div
              key={index}
              className="bg-secondary/80 rounded-sm border"
              aria-hidden="true"
            />
          ))}
        </div>
      </div>
      <div className="border-border/70 bg-card/50 absolute right-12 bottom-12 hidden h-28 w-72 rounded-lg border p-4 shadow-xs lg:block">
        <div className="mb-3 flex items-center gap-2">
          <div className="bg-success size-2 rounded-full" />
          <div className="bg-muted h-2 w-24 rounded-full" />
        </div>
        <div className="bg-muted mb-2 h-2 w-full rounded-full" />
        <div className="bg-muted h-2 w-2/3 rounded-full" />
      </div>

      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>

      <Card className="bg-card/94 border-border/80 w-full max-w-sm shadow-lg shadow-primary/5 backdrop-blur">
        <CardHeader className="text-center">
          <div className="bg-primary text-primary-foreground relative mx-auto mb-2 flex size-12 items-center justify-center overflow-hidden rounded-xl">
            <div className="absolute inset-x-2 top-3 h-px bg-primary-foreground/35" />
            <div className="absolute inset-y-2 left-3 w-px bg-primary-foreground/25" />
            <FolderSync className="size-6" aria-hidden="true" />
          </div>
          <CardTitle className="text-lg">专利数据湖仓一体化平台</CardTitle>
          <CardDescription>登录后管理同步批次和专利数据</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit}>
            <FieldGroup className="gap-4">
              <Field>
                <FieldLabel htmlFor="username">用户名</FieldLabel>
              <Input
                id="username"
                placeholder="请输入用户名"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoFocus
              />
              </Field>
              <Field>
                <FieldLabel htmlFor="password">密码</FieldLabel>
              <Input
                id="password"
                type="password"
                placeholder="请输入密码"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
              </Field>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading && <Spinner data-icon="inline-start" />}
              登录
            </Button>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
