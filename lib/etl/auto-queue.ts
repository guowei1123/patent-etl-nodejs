import { getPool } from '@/lib/db'

export const AUTO_QUEUE_VERSION = 1

export const AUTO_STAGES = ['download', 'process', 'import', 'cleanup'] as const
export type AutoStage = (typeof AUTO_STAGES)[number]

export const AUTO_TASK_STATUSES = [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const
export type AutoTaskStatus = (typeof AUTO_TASK_STATUSES)[number]

export interface AutoSyncTask {
  id: number
  batch_code: string
  stage: AutoStage
  status: AutoTaskStatus
  priority: number
  manual_override: boolean
  attempt_count: number
  max_attempts: number
  next_run_at: Date
  worker_id: string | null
  lease_expires_at: Date | null
  heartbeat_at: Date | null
  cancel_requested: boolean
  last_error: string | null
  progress_details: Record<string, unknown> | null
  created_at: Date
  started_at: Date | null
  completed_at: Date | null
  updated_at: Date
}

const DEFAULT_STAGE_LAUNCH_LIMITS: Record<AutoStage, number> = {
  download: 5,
  process: 2,
  import: 1,
  cleanup: 1,
}

const STAGE_LIMIT_ENV: Record<AutoStage, string> = {
  download: 'DOWNLOAD_BATCH_LIMIT',
  process: 'PROCESS_BATCH_LIMIT',
  import: 'IMPORT_BATCH_LIMIT',
  cleanup: 'CLEANUP_BATCH_LIMIT',
}

function positiveLimit(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

const RUNNING_BATCH_STATUS: Partial<Record<AutoStage, string>> = {
  download: 'downloading',
  process: 'processing',
  import: 'importing',
}

function isAutoStage(value: string): value is AutoStage {
  return AUTO_STAGES.includes(value as AutoStage)
}

export function getAutoStageLimit(stage: AutoStage): number {
  if (stage === 'download') {
    return Math.min(
      positiveLimit(process.env.AUTO_DOWNLOAD_BATCH_LIMIT, 3),
      getAutoStageLaunchLimit('download'),
    )
  }
  return getAutoStageLaunchLimit(stage)
}

export function getAutoStageLaunchLimit(stage: AutoStage): number {
  return positiveLimit(process.env[STAGE_LIMIT_ENV[stage]], DEFAULT_STAGE_LAUNCH_LIMITS[stage])
}

export async function enqueueAutoTask(
  batchCode: string,
  stage: AutoStage,
  options: { priority?: number; manualOverride?: boolean } = {},
): Promise<AutoSyncTask> {
  const pool = await getPool()
  const priority = options.priority ?? 0
  const manualOverride = options.manualOverride ?? false
  const resetCondition = `(auto_sync_tasks.status IN ('failed', 'cancelled', 'completed')
    OR (auto_sync_tasks.status = 'queued' AND auto_sync_tasks.attempt_count >= auto_sync_tasks.max_attempts))`
  const result = await pool.query<AutoSyncTask>(
    `INSERT INTO auto_sync_tasks (
       batch_code, stage, queue_version, status, priority, manual_override, next_run_at
     ) VALUES ($1, $2, $3, 'queued', $4, $5, CURRENT_TIMESTAMP)
     ON CONFLICT (batch_code, stage, queue_version)
     DO UPDATE SET
       priority = GREATEST(auto_sync_tasks.priority, EXCLUDED.priority),
       manual_override = auto_sync_tasks.manual_override OR EXCLUDED.manual_override,
       status = CASE
         WHEN ${resetCondition} THEN 'queued'
         ELSE auto_sync_tasks.status
       END,
       attempt_count = CASE
         WHEN ${resetCondition} THEN 0
         ELSE auto_sync_tasks.attempt_count
       END,
       next_run_at = CASE
         WHEN ${resetCondition} THEN CURRENT_TIMESTAMP
         ELSE auto_sync_tasks.next_run_at
       END,
       worker_id = CASE
         WHEN ${resetCondition} THEN NULL
         ELSE auto_sync_tasks.worker_id
       END,
       lease_expires_at = CASE
         WHEN ${resetCondition} THEN NULL
         ELSE auto_sync_tasks.lease_expires_at
       END,
       cancel_requested = false,
       last_error = CASE
         WHEN ${resetCondition} THEN NULL
         ELSE auto_sync_tasks.last_error
       END,
       progress_details = CASE
         WHEN ${resetCondition} THEN NULL
         ELSE auto_sync_tasks.progress_details
       END,
       completed_at = CASE
         WHEN ${resetCondition} THEN NULL
         ELSE auto_sync_tasks.completed_at
       END,
       updated_at = CURRENT_TIMESTAMP
     RETURNING *`,
    [batchCode, stage, AUTO_QUEUE_VERSION, priority, manualOverride],
  )
  return result.rows[0]
}

export async function enqueueCompletedBatchCleanupTasks(
  batchCodes: string[],
): Promise<AutoSyncTask[]> {
  if (batchCodes.length === 0) return []

  const pool = await getPool()
  const result = await pool.query<Pick<AutoSyncTask, 'batch_code'>>(
    `SELECT batch_code
       FROM sync_batches
      WHERE batch_code = ANY($1)
        AND status = 'completed'`,
    [batchCodes],
  )

  const tasks: AutoSyncTask[] = []
  for (const { batch_code: batchCode } of result.rows) {
    tasks.push(await enqueueAutoTask(batchCode, 'cleanup'))
  }
  return tasks
}

export async function getActiveAutoTask(
  batchCode: string,
): Promise<AutoSyncTask | null> {
  const pool = await getPool()
  const result = await pool.query<AutoSyncTask>(
    `SELECT * FROM auto_sync_tasks
      WHERE batch_code = $1
        AND queue_version = $2
        AND status IN ('queued', 'running')
        AND (status = 'running' OR attempt_count < max_attempts)
      ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, priority DESC, id ASC
      LIMIT 1`,
    [batchCode, AUTO_QUEUE_VERSION],
  )
  return result.rows[0] ?? null
}

export async function requestAutoTaskCancellation(
  batchCode: string,
): Promise<{ requested: boolean; running: boolean }> {
  const pool = await getPool()
  const result = await pool.query<Pick<AutoSyncTask, 'status'>>(
    `UPDATE auto_sync_tasks
        SET status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
            cancel_requested = CASE WHEN status = 'running' THEN true ELSE cancel_requested END,
            completed_at = CASE WHEN status = 'queued' THEN CURRENT_TIMESTAMP ELSE completed_at END,
            updated_at = CURRENT_TIMESTAMP
      WHERE batch_code = $1
        AND queue_version = $2
        AND status IN ('queued', 'running')
      RETURNING status`,
    [batchCode, AUTO_QUEUE_VERSION],
  )
  const task = result.rows[0]
  return { requested: Boolean(task), running: task?.status === 'running' }
}

export async function claimNextAutoTask(
  stage: AutoStage,
  workerId: string,
  leaseSeconds = 90,
): Promise<AutoSyncTask | null> {
  const pool = await getPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const lock = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_xact_lock($1) AS acquired',
      [913247],
    )
    if (!lock.rows[0]?.acquired) {
      await client.query('ROLLBACK')
      return null
    }

    await client.query(
      `UPDATE auto_sync_tasks
          SET status = CASE
                WHEN cancel_requested THEN 'cancelled'
                WHEN attempt_count >= max_attempts THEN 'failed'
                ELSE 'queued'
              END,
              worker_id = NULL, lease_expires_at = NULL,
              completed_at = CASE
                WHEN cancel_requested OR attempt_count >= max_attempts THEN CURRENT_TIMESTAMP
                ELSE NULL
              END,
              last_error = CASE
                WHEN attempt_count >= max_attempts THEN COALESCE(last_error, '任务租约过期，已达到最大重试次数，请手动重试')
                ELSE last_error
              END,
              updated_at = CURRENT_TIMESTAMP
        WHERE queue_version = $1
          AND ((status = 'running' AND lease_expires_at < CURRENT_TIMESTAMP)
            OR (status = 'queued' AND attempt_count >= max_attempts))`,
      [AUTO_QUEUE_VERSION],
    )

    const active = await client.query<{ count: string }>(
      `SELECT COUNT(*) FROM auto_sync_tasks
        WHERE queue_version = $1
          AND stage = $2
          AND status = 'running'
          AND lease_expires_at >= CURRENT_TIMESTAMP`,
      [AUTO_QUEUE_VERSION, stage],
    )
    const activeCount = Number(active.rows[0]?.count ?? 0)
    const launchLimit = getAutoStageLaunchLimit(stage)
    if (activeCount >= launchLimit) {
      await client.query('COMMIT')
      return null
    }

    const canLaunchAutomaticTask =
      stage !== 'download' || activeCount < getAutoStageLimit('download')
    const task = await client.query<AutoSyncTask>(
      `WITH candidate AS (
         SELECT id FROM auto_sync_tasks
          WHERE queue_version = $1
            AND stage = $2
            AND status = 'queued'
            AND attempt_count < max_attempts
            AND cancel_requested = false
            AND next_run_at <= CURRENT_TIMESTAMP
            AND (manual_override = TRUE OR $5::boolean)
          ORDER BY manual_override DESC, priority DESC, id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       UPDATE auto_sync_tasks task
          SET status = 'running', worker_id = $3,
              attempt_count = attempt_count + 1,
              started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
              heartbeat_at = CURRENT_TIMESTAMP,
              lease_expires_at = CURRENT_TIMESTAMP + ($4 * INTERVAL '1 second'),
              updated_at = CURRENT_TIMESTAMP
         FROM candidate
        WHERE task.id = candidate.id
       RETURNING task.*`,
      [
        AUTO_QUEUE_VERSION,
        stage,
        workerId,
        leaseSeconds,
        canLaunchAutomaticTask,
      ],
    )
    const claimedTask = task.rows[0] ?? null
    const batchStatus = claimedTask
      ? RUNNING_BATCH_STATUS[claimedTask.stage]
      : undefined
    if (claimedTask && batchStatus) {
      await client.query(
        `UPDATE sync_batches
            SET status = $2, error_message = NULL, completed_at = NULL,
                started_at = COALESCE(started_at, CURRENT_TIMESTAMP)
          WHERE batch_code = $1`,
        [claimedTask.batch_code, batchStatus],
      )
    }

    await client.query('COMMIT')
    return claimedTask
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

export async function heartbeatAutoTask(
  id: number,
  workerId: string,
  progressDetails: Record<string, unknown> | null,
  leaseSeconds = 90,
): Promise<{ alive: boolean; cancelRequested: boolean }> {
  const pool = await getPool()
  const result = await pool.query<Pick<AutoSyncTask, 'cancel_requested'>>(
    `UPDATE auto_sync_tasks
        SET heartbeat_at = CURRENT_TIMESTAMP,
            lease_expires_at = CURRENT_TIMESTAMP + ($4 * INTERVAL '1 second'),
            progress_details = COALESCE($3::jsonb, progress_details),
            updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND worker_id = $2 AND status = 'running'
      RETURNING cancel_requested`,
    [id, workerId, progressDetails ? JSON.stringify(progressDetails) : null, leaseSeconds],
  )
  return {
    alive: result.rows.length > 0,
    cancelRequested: result.rows[0]?.cancel_requested ?? false,
  }
}

export async function completeAutoTask(
  id: number,
  workerId: string,
  progressDetails: Record<string, unknown> | null = null,
): Promise<void> {
  const pool = await getPool()
  await pool.query(
    `UPDATE auto_sync_tasks
        SET status = 'completed', worker_id = NULL, lease_expires_at = NULL,
            heartbeat_at = CURRENT_TIMESTAMP,
            progress_details = COALESCE($3::jsonb, progress_details),
            completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND worker_id = $2 AND status = 'running'`,
    [id, workerId, progressDetails ? JSON.stringify(progressDetails) : null],
  )
}

export async function cancelAutoTask(id: number, workerId: string): Promise<void> {
  const pool = await getPool()
  await pool.query(
    `UPDATE auto_sync_tasks
        SET status = 'cancelled', worker_id = NULL, lease_expires_at = NULL,
            completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND worker_id = $2 AND status = 'running'`,
    [id, workerId],
  )
}

export async function failAutoTask(
  task: AutoSyncTask,
  workerId: string,
  errorMessage: string,
): Promise<{ retrying: boolean }> {
  const pool = await getPool()
  const retrying = task.attempt_count < task.max_attempts
  // status 列为 VARCHAR；同一参数还参与 CASE 比较，必须明确类型以免被推断成 TEXT。
  const result = await pool.query(
    `UPDATE auto_sync_tasks
        SET status = $3::varchar,
            worker_id = NULL,
            lease_expires_at = NULL,
            next_run_at = CASE
              WHEN $3::varchar = 'queued' THEN CURRENT_TIMESTAMP + INTERVAL '30 seconds'
              ELSE next_run_at
            END,
            last_error = $4,
            updated_at = CURRENT_TIMESTAMP,
            completed_at = CASE WHEN $3::varchar = 'failed' THEN CURRENT_TIMESTAMP ELSE NULL END
      WHERE id = $1 AND worker_id = $2 AND status = 'running'`,
    [task.id, workerId, retrying ? 'queued' : 'failed', errorMessage],
  )
  return { retrying: result.rowCount === 1 && retrying }
}

export function parseAutoStage(value: string): AutoStage | null {
  return isAutoStage(value) ? value : null
}
