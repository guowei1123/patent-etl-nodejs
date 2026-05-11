'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { cn } from '@/lib/utils'
import {
  LayoutDashboard,
  Layers,
  FileText,
  Settings,
  FolderSync,
  LogOut,
} from 'lucide-react'

const navigation = [
  { name: '仪表盘', href: '/', icon: LayoutDashboard },
  { name: '批次管理', href: '/batches', icon: Layers },
  { name: '专利数据', href: '/patents', icon: FileText },
  { name: '设置', href: '/settings', icon: Settings },
]

export function Sidebar() {
  const pathname = usePathname()
  const router = useRouter()

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' })
    router.push('/login')
    router.refresh()
  }

  return (
    <aside className="bg-sidebar border-sidebar-border fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r">
      {/* Logo */}
      <div className="border-sidebar-border flex h-16 items-center gap-3 border-b px-6">
        <div className="bg-accent flex h-8 w-8 items-center justify-center rounded-lg">
          <FolderSync className="text-accent-foreground h-4 w-4" />
        </div>
        <div className="flex flex-col">
          <span className="text-sidebar-foreground text-sm font-semibold">
            专利湖仓平台
          </span>
          <span className="text-muted-foreground text-xs">数据湖仓一体化</span>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-1 px-3 py-4">
        {navigation.map((item) => {
          const isActive =
            pathname === item.href ||
            (item.href !== '/' && pathname.startsWith(item.href))

          return (
            <Link
              key={item.name}
              href={item.href}
              className={cn(
                'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.name}
            </Link>
          )
        })}
      </nav>

      {/* Status Footer */}
      <div className="border-sidebar-border border-t p-4">
        <button
          onClick={handleLogout}
          className="text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs transition-colors"
        >
          <LogOut className="h-3 w-3" />
          退出登录
        </button>
      </div>
    </aside>
  )
}
