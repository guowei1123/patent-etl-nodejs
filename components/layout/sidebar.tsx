'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import {
  LayoutDashboard,
  Layers,
  FileText,
  Settings,
  FolderSync,
  LogOut,
} from 'lucide-react'
import {
  Sidebar as SidebarPanel,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar'

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
    <SidebarPanel variant="inset" collapsible="icon">
      <SidebarHeader className="border-sidebar-border/80 border-b p-3">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              size="lg"
              tooltip="专利湖仓平台"
              className="h-14 rounded-xl group-data-[collapsible=icon]:p-0!"
            >
              <Link href="/">
                <div className="bg-sidebar-primary text-sidebar-primary-foreground relative flex aspect-square size-9 items-center justify-center overflow-hidden rounded-lg">
                  <div className="absolute inset-x-1 top-2 h-px bg-sidebar-primary-foreground/35" />
                  <div className="absolute inset-y-1 left-2 w-px bg-sidebar-primary-foreground/25" />
                  <FolderSync className="size-4" aria-hidden="true" />
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">专利湖仓平台</span>
                  <span className="text-sidebar-foreground/62 truncate text-xs">
                    FTP · XML · PostgreSQL
                  </span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>主导航</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navigation.map((item) => {
                const isActive =
                  pathname === item.href ||
                  (item.href !== '/' && pathname.startsWith(item.href))

                return (
                  <SidebarMenuItem key={item.name}>
                    <SidebarMenuButton
                      asChild
                      isActive={isActive}
                      tooltip={item.name}
                    >
                      <Link href={item.href}>
                        <item.icon aria-hidden="true" />
                        <span>{item.name}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-sidebar-border border-t p-3">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="退出登录" onClick={handleLogout}>
              <LogOut aria-hidden="true" />
              <span>退出登录</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
    </SidebarPanel>
  )
}
