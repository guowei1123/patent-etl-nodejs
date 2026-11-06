import { NextRequest, NextResponse } from 'next/server'
import { getPool } from '../../lib/db'
import { generateBatchCode } from '../../lib/batch-code'

async function isHistoricalBatch(code: string) {
  if (code.startsWith('HIST-')) return true
  if (!/^CN-PA-TXTS-(10-[AB]|20-U)-\d{8}$/.test(code)) return false
  const pool = await getPool()
  const batch = await pool.query<{ ftp_folder: string | null }>(
    'SELECT ftp_folder FROM sync_batches WHERE batch_code=$1',
    [code],
  )
  if (!batch.rows[0]) return false
  if (!batch.rows[0].ftp_folder) return true
  // FTP and historical imports share batch names. Protect mixed batches as well.
  const table = await pool.query<{ source: string | null }>(
    "SELECT to_regclass('cnipa.history_import_source') AS source",
  )
  if (!table.rows[0]?.source) return false
  const history = await pool.query(
    'SELECT 1 FROM cnipa.history_import_source WHERE announcement_batch=$1 LIMIT 1',
    [code],
  )
  return !!history.rows.length
}

export async function guardHistoricalBatch(request: NextRequest) {
  const pathname = request.nextUrl.pathname
  let code: string | undefined
  const deletion =
    request.method === 'DELETE' && /^\/api\/batches\/[^/]+$/.test(pathname)
  if (deletion) code = decodeURIComponent(pathname.split('/').pop()!)
  if (request.method === 'POST' && pathname.startsWith('/api/sync/')) {
    const body = await request
      .clone()
      .json()
      .catch(() => null)
    if (typeof body?.batch_code === 'string') code = body.batch_code
    else if (
      typeof body?.ftp_folder === 'string' &&
      typeof body?.data_type === 'string'
    )
      code = generateBatchCode(body.data_type, body.ftp_folder)
  }
  if (!code) return null
  try {
    if (!(await isHistoricalBatch(code))) return null
  } catch {
    return NextResponse.json(
      { success: false, error: '无法核对批次来源，请检查数据库连接后重试' },
      { status: 503 },
    )
  }
  return NextResponse.json(
    {
      success: false,
      error: deletion
        ? '批次包含历史数据，不能通过 FTP 批次接口删除，请在历史数据导入页面管理来源和清理对象'
        : '批次包含历史数据，不执行 FTP 操作，请前往历史数据导入页面创建任务',
    },
    { status: 400 },
  )
}
