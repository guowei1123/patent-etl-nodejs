import { appendFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { isOssConfigured, putPatentImage } from '../../../lib/oss-client.ts'
import { importPdfManifest } from './historical-pdf-import.ts'

const args = process.argv.slice(2)
function option(name: string) {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}
const batch = option('--batch')
const input = option('--input')
const commit = args.includes('--commit')
if (
  !batch ||
  !/^[A-Za-z0-9_-]+$/.test(batch) ||
  !input ||
  args.some(
    (arg, i) =>
      i > 0 &&
      args[i - 1].startsWith('--') &&
      args[i - 1] !== '--commit' &&
      arg.startsWith('--'),
  )
) {
  console.error(
    '用法：pnpm pdf:import --batch PDF-20261012-001 --input data/historical-pdf/PDF-20261012-001 [--commit]',
  )
  process.exit(1)
}
const pool = new pg.Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : {
        host: process.env.CNIPA_PG_HOST,
        port: Number(process.env.CNIPA_PG_PORT || 5432),
        database: process.env.CNIPA_PG_DB,
        user: process.env.CNIPA_PG_USER,
        password: process.env.CNIPA_PG_PASSWORD,
        connectionTimeoutMillis: 10000,
      },
)

async function* manifests(directory: string): AsyncGenerator<string> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) yield* manifests(target)
    else if (entry.isFile() && entry.name === 'manifest.json') yield target
  }
}

async function main() {
  if (!(process.env.DATABASE_URL || process.env.CNIPA_PG_HOST))
    throw new Error('请先在 .env 配置数据库')
  if (commit && !isOssConfigured())
    throw new Error('请先在 .env 配置 OSS / MinIO')
  if (commit) {
    await pool.query(`CREATE TABLE IF NOT EXISTS cnipa.historical_pdf_batch (
      batch_code TEXT PRIMARY KEY, source_directory TEXT NOT NULL, status TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`)
    await pool.query(`CREATE TABLE IF NOT EXISTS cnipa.historical_pdf_image (
      patent_id UUID NOT NULL REFERENCES cnipa.patent(id) ON DELETE CASCADE,
      pdf_hash TEXT NOT NULL, page_number INTEGER NOT NULL,
      image_id UUID NOT NULL REFERENCES cnipa.patent_image(id) ON DELETE CASCADE,
      batch_code TEXT NOT NULL REFERENCES cnipa.historical_pdf_batch(batch_code),
      source_file TEXT NOT NULL, extraction_version TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(patent_id,pdf_hash,page_number))`)
    await pool.query(
      `INSERT INTO cnipa.historical_pdf_batch VALUES ($1,$2,'importing',now())
      ON CONFLICT (batch_code) DO UPDATE SET status='importing',updated_at=now()`,
      [batch, path.resolve(input!)],
    )
  }
  let failures = 0
  let count = 0
  for await (const file of manifests(path.resolve(input!))) {
    let result
    try {
      result = await importPdfManifest(
        file,
        batch!,
        commit,
        pool,
        putPatentImage,
      )
    } catch {
      // Do not expose DB connection strings, storage credentials or SDK request details.
      result = {
        status: 'failed',
        manifest: file,
        reason: '匹配、校验或导入失败，请检查配置、服务连接和清单',
      }
    }
    if (result.status === 'failed' || result.status === 'unmatched') failures++
    count++
    console.log(JSON.stringify(result))
    await appendFile(
      path.resolve(
        input!,
        commit ? 'import-results.jsonl' : 'preview-results.jsonl',
      ),
      JSON.stringify(result) + '\n',
    )
  }
  if (!count) throw new Error('没有提取清单，请先运行 pdf:extract')
  if (commit)
    await pool.query(
      'UPDATE cnipa.historical_pdf_batch SET status=$2,updated_at=now() WHERE batch_code=$1',
      [batch, failures ? 'failed' : 'completed'],
    )
  console.log(
    `已检查 ${count} 份清单，失败或未匹配 ${failures} 份；${commit ? '已执行入库' : '仅预览，未写入数据库和对象存储'}`,
  )
  if (failures) process.exitCode = 1
}

try {
  await main()
} catch {
  console.error(
    'PDF 导入未完成，请检查依赖、输入目录、数据库表及 .env 服务配置。',
  )
  process.exitCode = 1
} finally {
  await pool.end()
}
