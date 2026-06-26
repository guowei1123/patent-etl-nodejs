'use client'

import { Button } from '@/components/ui/button'
import { ThemeToggle } from '@/components/layout/theme-toggle'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'

interface HeaderProps {
  title: string
  description?: string
  action?: React.ReactNode
  onRefresh?: () => void
  isRefreshing?: boolean
}

export function Header({
  title,
  description,
  action,
  onRefresh,
  isRefreshing,
}: HeaderProps) {
  return (
    <header className="border-border/70 bg-background/88 supports-backdrop-filter:bg-background/72 sticky top-0 z-40 flex h-16 items-center justify-between border-b px-6 backdrop-blur-xl">
      <div className="flex min-w-0 items-center gap-3">
        <SidebarTrigger className="text-muted-foreground hover:text-foreground size-8" />
        <div className="bg-primary/70 hidden h-8 w-px sm:block" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <h1 className="text-foreground truncate text-lg font-semibold tracking-tight">
            {title}
          </h1>
          {description && (
            <p className="text-muted-foreground truncate text-sm">
              {description}
            </p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <ThemeToggle />
        {onRefresh && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onRefresh}
            disabled={isRefreshing}
            className="size-8"
            aria-label="刷新数据"
          >
            <RefreshCw
              className={cn(isRefreshing && 'animate-spin')}
              data-icon="inline-start"
            />
          </Button>
        )}
        {action}
      </div>
    </header>
  )
}
