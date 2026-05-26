export interface StepResult {
  success: boolean
  batchCode: string
  error?: string
  details?: Record<string, unknown>
}
