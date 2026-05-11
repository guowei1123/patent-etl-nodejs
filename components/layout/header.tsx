'use client'

import { Button } from '@/components/ui/button'
import { ThemeToggle } from '@/components/layout/theme-toggle'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { RefreshCw } from 'lucide-react'

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
    <header className="border-border/80 bg-background/85 supports-backdrop-filter:bg-background/70 sticky top-0 z-40 flex h-16 items-center justify-between border-b px-6 backdrop-blur">
      <div className="flex min-w-0 items-center gap-3">
        <SidebarTrigger className="text-muted-foreground hover:text-foreground size-8" />
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
            className="h-8 w-8"
          >
            <RefreshCw
              className={cn('h-4 w-4', isRefreshing && 'animate-spin')}
            />
          </Button>
        )}
        {action}
      </div>
    </header>
  )
}

function cn(...classes: (string | boolean | undefined)[]) {
  return classes.filter(Boolean).join(' ')
}
