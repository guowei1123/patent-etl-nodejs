import { cn } from '@/lib/utils'

export function PatentLogoMark({
  className,
}: {
  className?: string
}) {
  return (
    <div
      className={cn(
        'bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-9 items-center justify-center overflow-hidden rounded-lg',
        className,
      )}
      aria-hidden="true"
    >
      <svg
        viewBox="0 0 36 36"
        fill="none"
        className="size-7"
        focusable="false"
      >
        <path
          d="M12 7.5h9l5 5v16H12z"
          fill="currentColor"
          fillOpacity="0.16"
        />
        <path
          d="M12 7.5h9l5 5v16H12z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <path
          d="M21 7.5v5h5"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <path
          d="M15.5 16.5h7M15.5 20h7M15.5 23.5h4"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path
          d="M8.5 12.5v15h13"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity="0.62"
        />
        <path
          d="M9.5 9.5h3M6.5 16.5h5M6.5 21h5"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          opacity="0.82"
        />
      </svg>
    </div>
  )
}
