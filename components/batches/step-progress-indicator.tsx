'use client'

import { CheckCircle2, XCircle } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'
import type { BatchStatus, SyncBatch } from '@/types'
import { cn } from '@/lib/utils'
import { stepConfig } from './step-config'

interface StepProgressIndicatorProps {
  status: BatchStatus
  compact?: boolean
  batch?: SyncBatch
}

type StepState = 'done' | 'running' | 'failed' | 'pending'

function getStepStates(status: BatchStatus, batch?: SyncBatch): StepState[] {
  if (status === 'completed') return ['done', 'done', 'done']

  if (status === 'failed') {
    if (!batch) return ['pending', 'pending', 'pending']
    const downloadDone =
      batch.total_files > 0 && batch.processed_files >= batch.total_files
    const processDone = batch.total_patents > 0
    const importDone =
      batch.total_patents > 0 && batch.imported_patents >= batch.total_patents

    if (importDone) return ['done', 'done', 'failed']
    if (processDone) return ['done', 'done', 'failed']
    if (downloadDone) return ['done', 'failed', 'pending']
    return ['failed', 'pending', 'pending']
  }

  const activeIndex = stepConfig.findIndex(
    (s) => status === s.runningStatus || status === s.doneStatus,
  )

  return stepConfig.map((step, i) => {
    if (status === step.doneStatus) return 'done' as const
    if (status === step.runningStatus) return 'running' as const
    if (activeIndex !== -1 && i < activeIndex) return 'done' as const
    return 'pending' as const
  })
}

export function StepProgressIndicator({
  status,
  compact,
  batch,
}: StepProgressIndicatorProps) {
  const iconSize = compact ? 'size-3' : 'size-3.5'
  const circleSize = compact ? 'size-5' : 'size-7'
  const lineWidth = compact ? 'w-4' : 'w-8'
  const textSize = compact ? 'text-[10px]' : 'text-xs'
  const states = getStepStates(status, batch)

  return (
    <div className="flex items-center gap-2">
      {stepConfig.map((step, index) => {
        const state = states[index]
        const StepIcon = step.icon
        const isDone = state === 'done'
        const isFailed = state === 'failed'
        const isRunning = state === 'running'
        const lineDone = isDone

        return (
          <div key={step.key} className="flex items-center gap-2">
            {index > 0 && (
              <div
                className={cn(
                  'h-px',
                  lineWidth,
                  lineDone ? 'bg-success' : 'bg-border',
                )}
              />
            )}
            <div className="flex items-center gap-1.5">
              <div
                className={cn(
                  'flex items-center justify-center rounded-full text-xs',
                  circleSize,
                  isDone
                    ? 'bg-success/20 text-success'
                    : isFailed
                      ? 'bg-destructive/20 text-destructive'
                      : isRunning
                        ? 'bg-warning/20 text-warning'
                        : 'bg-secondary text-muted-foreground',
                )}
              >
                {isRunning ? (
                  <Spinner className={iconSize} />
                ) : isDone ? (
                  <CheckCircle2 aria-hidden="true" className={iconSize} />
                ) : isFailed ? (
                  <XCircle aria-hidden="true" className={iconSize} />
                ) : (
                  <StepIcon aria-hidden="true" className={iconSize} />
                )}
              </div>
              <span
                className={cn(
                  textSize,
                  isDone
                    ? 'text-success'
                    : isFailed
                      ? 'text-destructive'
                      : isRunning
                        ? 'text-warning'
                        : 'text-muted-foreground',
                )}
              >
                {step.label}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}
