import { randomUUID } from 'node:crypto'
import {
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
  realpath,
  stat,
} from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { HistoryJob, ImportConfig } from './model.ts'
import { emptySummary } from './model.ts'

export const jobRoot = path.resolve('data/historical-import')
export const pythonPath = () =>
  process.env.PDF_PYTHON ||
  path.resolve(
    '.venv-pdf',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
  )
export function jobDirectory(id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('任务编号无效')
  return path.join(jobRoot, id)
}
export async function saveJob(job: HistoryJob) {
  const directory = jobDirectory(job.id)
  await mkdir(directory, { recursive: true })
  job.updatedAt = new Date().toISOString()
  const temporary = path.join(directory, `state-${randomUUID()}.part`)
  await writeFile(temporary, JSON.stringify(job), 'utf8')
  await rename(temporary, path.join(directory, 'state.json'))
}
export async function getJob(id: string): Promise<HistoryJob> {
  return JSON.parse(
    await readFile(path.join(jobDirectory(id), 'state.json'), 'utf8'),
  )
}
export async function listJobs() {
  await mkdir(jobRoot, { recursive: true })
  const entries = await readdir(jobRoot, { withFileTypes: true })
  const jobs: HistoryJob[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue
    try {
      const job = await getJob(entry.name)
      if (job.pid && ['pending', 'processing'].includes(job.status)) {
        try {
          process.kill(job.pid, 0)
        } catch {
          job.status = 'failed'
          job.message =
            '后台进程已结束，请重新创建任务；已入库记录可在重试时复用。'
          await saveJob(job)
        }
      }
      jobs.push(job)
    } catch {
      /* An incomplete state file never prevents listing other jobs. */
    }
  }
  return jobs
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 30)
}
export async function validateSources(config: ImportConfig) {
  for (const [key, extension] of [
    ['excelPath', '.xlsx'],
    ['descriptionPath', '.parquet'],
    ['claimsPath', '.parquet'],
    ['pdfPath', '.pdf'],
  ] as const) {
    if (config.stage === 'metadata' && key !== 'excelPath') continue
    if (
      config.stage === 'text' &&
      !['descriptionPath', 'claimsPath'].includes(key)
    )
      continue
    if (config.stage === 'images' && key !== 'pdfPath') continue
    const source = config[key]
    if (!source) continue
    if (!path.isAbsolute(source)) throw new Error('请填写服务器本机的绝对路径')
    let resolved: string
    try {
      resolved = await realpath(source)
    } catch {
      throw new Error(`来源路径不存在或不可读取：${key}`)
    }
    if (
      resolved.toLowerCase().includes(`${path.sep}.git${path.sep}`) ||
      path.basename(resolved).startsWith('.env')
    )
      throw new Error('不能将配置文件作为数据来源')
    if (process.env.HISTORICAL_IMPORT_SOURCE_ROOT) {
      const root = await realpath(process.env.HISTORICAL_IMPORT_SOURCE_ROOT)
      const relative = path.relative(root, resolved)
      if (
        relative === '..' ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      )
        throw new Error('数据来源超出允许目录')
    }
    const relativeOutput = path.relative(resolved, jobRoot)
    if (
      !relativeOutput ||
      (!relativeOutput.startsWith('..') && !path.isAbsolute(relativeOutput))
    )
      throw new Error('来源目录不能包含任务输出目录')
    const info = await stat(resolved)
    if (
      !info.isDirectory() &&
      !(key === 'pdfPath'
        ? /\.(pdf|tar|tar\.gz|tgz|zip)$/i.test(resolved)
        : resolved.toLowerCase().endsWith(extension))
    )
      throw new Error(`文件格式不符合来源要求：${key}`)
    config[key] = resolved
  }
}
export async function createJob(
  config: ImportConfig,
  mode: HistoryJob['mode'],
) {
  await validateSources(config)
  const timestamp = new Date().toISOString()
  const job: HistoryJob = {
    id: randomUUID(),
    mode,
    status: 'pending',
    createdAt: timestamp,
    updatedAt: timestamp,
    message: '等待检查来源文件…',
    config,
    summary: emptySummary(),
    processed: 0,
    sample: [],
  }
  await saveJob(job)
  await writeFile(
    path.join(jobDirectory(job.id), 'config.json'),
    JSON.stringify(config),
    'utf8',
  )
  const child = spawn(
    process.execPath,
    [
      '--env-file-if-exists=.env',
      '--experimental-strip-types',
      path.resolve('features/historical-import/worker.ts'),
      job.id,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, PYTHONUTF8: '1' },
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    },
  )
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  child.unref()
  // The worker owns subsequent state updates; do not overwrite its progress here.
  return job
}
