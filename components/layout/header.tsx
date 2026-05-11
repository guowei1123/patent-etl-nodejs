'use client'

import { Button } from '@/components/ui/button'
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
    <header className="border-border bg-background/95 supports-[backdrop-filter]:bg-background/60 sticky top-0 z-40 flex h-16 items-center justify-between border-b px-6 backdrop-blur">
      <div className="flex flex-col gap-0.5">
        <h1 className="text-foreground text-lg font-semibold">{title}</h1>
        {description && (
          <p className="text-muted-foreground text-sm">{description}</p>
        )}
      </div>

      <div className="flex items-center gap-3">
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
