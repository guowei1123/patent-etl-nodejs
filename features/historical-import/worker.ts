import { createReadStream } from 'node:fs'
import { appendFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import pg from 'pg'
import { getJob, saveJob, jobDirectory, pythonPath } from './jobs.ts'
import { setupHistorySchema, publishRecord } from './publish.ts'
import { isOssConfigured, putPatentImage } from '../../lib/oss-client.ts'
import type { HistoryJob, ImportRecord } from './model.ts'
import { snapshotRequested } from './database-snapshot.ts'

const id = process.argv[2]
const job: HistoryJob = await getJob(id)
const directory = jobDirectory(id)
const pool = new pg.Pool(
  process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        connectionTimeoutMillis: 10000,
      }
    : {
        host: process.env.CNIPA_PG_HOST,
        port: Number(process.env.CNIPA_PG_PORT || 5432),
        database: process.env.CNIPA_PG_DB,
        user: process.env.CNIPA_PG_USER,
        password: process.env.CNIPA_PG_PASSWORD,
        connectionTimeoutMillis: 10000,
      },
)
async function runPreparation(keys = false) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      pythonPath(),
      [
        path.resolve('features/historical-import/prepare.py'),
        '--config',
        path.join(directory, 'config.json'),
        '--output',
        directory,
        ...(keys ? ['--keys'] : []),
      ],
      {
        windowsHide: true,
        env: { ...process.env, PYTHONUTF8: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let updates = Promise.resolve()
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      try {
        const item = JSON.parse(line)
        if (item.message) {
          job.message = String(item.message).slice(0, 240)
          updates = updates.then(() => saveJob(job))
        }
        if (item.error) job.message = String(item.error).slice(0, 240)
      } catch {
        /* OCR library diagnostics are not job messages. */
      }
    })
    child.stderr.resume()
    child.on('error', () => reject(new Error('无法启动 Python 环境')))
    child.on('close', (code) => {
      updates.then(() =>
        code === 0
          ? resolve()
          : reject(new Error('来源关联失败，请检查路径、列映射和 Python 依赖')),
      )
    })
  })
}
try {
  job.pid = process.pid
  job.status = 'processing'
  job.message = '正在检查本阶段来源…'
  await saveJob(job)
  if (job.mode === 'import') {
    if (['all', 'images'].includes(job.config.stage) && !isOssConfigured())
      throw new Error('对象存储未配置')
    job.message = '正在初始化阶段记录与申请号归并索引…'
    await saveJob(job)
    await setupHistorySchema(pool)
  }
  if (['text', 'images'].includes(job.config.stage)) {
    await runPreparation(true)
    job.message = '正在按完整公开号分批匹配已有记录，准备待补齐文献…'
    await saveJob(job)
    await snapshotRequested(pool, directory, job.config)
  }
  await runPreparation()
  if (['text', 'images'].includes(job.config.stage))
    await appendFile(
      path.join(directory, 'source-errors.jsonl'),
      await readFile(path.join(directory, 'database-errors.jsonl')),
    )
  const lines = createInterface({
    input: createReadStream(path.join(directory, 'records.jsonl'), 'utf8'),
    crlfDelay: Infinity,
  })
  for await (const line of lines) {
    const record: ImportRecord = JSON.parse(line)
    job.summary.total++
    if (record.status === 'blocked') job.summary.blocked++
    else job.summary.ready++
    if (record.status === 'ready' && job.mode === 'import') {
      try {
        const result = await publishRecord(
          pool,
          record,
          job.config,
          id,
          putPatentImage,
        )
        if (result.skipped) job.summary.skipped++
        else job.summary.imported++
        job.summary.removedApplications += result.removed
      } catch (error) {
        job.summary.failed++
        record.status = 'blocked'
        const safeErrors = new Set([
          '同一公开号的申请号冲突，请核对基础信息',
          '数据库存在冲突的文献记录',
          '基础信息正在更新，请重新预览后重试',
          '公告日期超出处理范围，请调整日期后重试',
          '公开号与种类码不一致',
        ])
        record.reasons.push(
          error instanceof Error && safeErrors.has(error.message)
            ? error.message
            : '入库失败，请检查数据库、对象存储连接或冲突记录',
        )
      }
    }
    if (job.sample.length < 30)
      job.sample.push({ ...record, raw: {}, description: '', claims: '' })
    job.processed++
    job.message = `已检查 ${job.processed} 件文献，已导入 ${job.summary.imported} 件`
    await appendFile(
      path.join(directory, 'results.jsonl'),
      JSON.stringify({
        publication: record.publication,
        status: record.status,
        metadataPending: !!record.metadataPending,
        reasons: record.reasons,
      }) + '\n',
    )
    await saveJob(job)
  }
  if (!job.summary.total)
    throw new Error('未找到可处理文献，请检查公开号、来源异常报告和日期范围')
  job.status = job.summary.failed ? 'failed' : 'completed'
  job.message =
    job.mode === 'preview'
      ? '预览完成，请检查待补齐项及来源错误报告。'
      : '导入结束，已保存本阶段数据；基础信息待补齐记录可在后续任务补入，校验异常记录未写入。'
} catch (error) {
  job.status = 'failed'
  if (!job.message || !job.message.includes('错误'))
    job.message =
      error instanceof Error &&
      [
        '没有符合日期范围的文献，请检查列映射和日期',
        '未找到可处理文献，请检查公开号、来源异常报告和日期范围',
        '对象存储未配置',
        '数据库尚未初始化，请先打开专利数据页面',
        '无法启动 Python 环境',
        '来源关联失败，请检查路径、列映射和 Python 依赖',
      ].includes(error.message)
        ? error.message
        : '任务失败，请检查路径、字段映射、依赖与服务配置。'
} finally {
  await saveJob(job)
  await pool.end()
}
