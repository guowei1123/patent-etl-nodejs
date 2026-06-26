'use client'

import type { CSSProperties, ReactNode } from 'react'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { Sidebar } from '@/components/layout/sidebar'

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <SidebarProvider
      defaultOpen
      style={
        {
          '--sidebar-width': '17rem',
          '--sidebar-width-mobile': '18rem',
        } as CSSProperties
      }
    >
      <Sidebar />
      <SidebarInset className="min-h-svh bg-background/82">
        {children}
      </SidebarInset>
    </SidebarProvider>
  )
}
