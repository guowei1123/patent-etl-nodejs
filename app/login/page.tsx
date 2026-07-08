'use client'

import { useState, type FormEvent } from 'react'
import Image from 'next/image'
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
    <div className="bg-background relative flex min-h-dvh items-center justify-center overflow-hidden px-4 py-16 sm:py-20">
      <Image
        src="/login-bg-light.png"
        alt=""
        fill
        priority
        sizes="100vw"
        className="object-cover"
        aria-hidden="true"
      />
      <div
        className="absolute inset-0 bg-background/72 dark:bg-background/84"
        aria-hidden="true"
      />
      <div
        className="absolute inset-0 bg-[radial-gradient(circle_at_center,var(--background)_0%,color-mix(in_oklch,var(--background)_70%,transparent)_38%,transparent_72%)]"
        aria-hidden="true"
      />
      <div
        className="absolute inset-0 bg-[linear-gradient(to_bottom,color-mix(in_oklch,var(--background)_52%,transparent),transparent_28%,color-mix(in_oklch,var(--background)_56%,transparent))]"
        aria-hidden="true"
      />

      <div className="absolute top-4 right-4 z-20">
        <ThemeToggle />
      </div>

      <Card className="border-border/80 bg-card/96 relative z-10 w-full max-w-sm shadow-lg shadow-primary/5 backdrop-blur-md">
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
                  name="username"
                  placeholder="请输入用户名"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  spellCheck={false}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="password">密码</FieldLabel>
                <Input
                  id="password"
                  name="password"
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
