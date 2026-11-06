import { beforeAll, describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import { createHash } from 'node:crypto'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { publishRecord } from '../publish'
import { configSchema, type ImportRecord } from '../model'
import type { PdfManifest } from '../pdf/historical-pdf'

const publication = 'CN1577321B'
let pdfManifest: string
beforeAll(async () => {
  const directory = path.resolve(
    'data/historical-import/validation/import-order',
  )
  await mkdir(directory, { recursive: true })
  const content = await sharp({
    create: { width: 40, height: 40, channels: 3, background: 'white' },
  })
    .png()
    .toBuffer()
  const manifest: PdfManifest = {
    version: 'pdf-figures-v2',
    batch: 'HISTORY',
    patent_number: publication,
    pdf_hash: 'a'.repeat(64),
    source: 'order-fixture.zip::CN1577321B.pdf',
    images: ['abstract', 'drawing'].map((role, index) => ({
      file_name: `${publication}_${role}_001.png`,
      page: index + 1,
      width: 40,
      height: 40,
      content_hash: createHash('sha256').update(content).digest('hex'),
      figure_label: '图1',
      image_role: role as 'abstract' | 'drawing',
    })),
  }
  for (const image of manifest.images)
    await writeFile(path.join(directory, image.file_name), content)
  pdfManifest = path.join(directory, 'manifest.json')
  await writeFile(pdfManifest, JSON.stringify(manifest))
})

function source(stage: 'metadata' | 'text' | 'images'): ImportRecord {
  return {
    publication,
    kind: 'B',
    application: stage === 'metadata' ? 'CN2004100587248' : '',
    date: stage === 'metadata' ? '2008-01-01' : '',
    title: stage === 'metadata' ? '授权版' : '',
    abstract: '',
    applicant: '',
    inventor: '',
    ipc: '',
    grant: '',
    grantDate: '',
    description: stage === 'text' ? '说明书正文' : '',
    claims: stage === 'text' ? '权利要求正文' : '',
    raw: stage === 'metadata' ? { title: '授权版' } : {},
    source: `fixture:${stage}`,
    ...(stage === 'images' ? { pdfManifest } : {}),
    status: 'ready',
    reasons: [],
  }
}

// Stateful boundary fixture: capture database effects across separate tasks, rather than
// asserting isolated SQL strings. Image extraction and snapshot preparation have integration fixtures.
function database() {
  let patent:
    | {
        id: string
        app_number: unknown
        pub_date: unknown
        title: unknown
        batch_id: unknown
        description: unknown
        claims: unknown
      }
    | undefined
  const parts = new Map<string, string>()
  const batches = new Set<string>()
  const links: unknown[][] = []
  let asset: { id: string; oss_key: string } | undefined
  let inserts = 0
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    let rows: unknown[] = []
    if (sql.startsWith('SELECT app_number FROM'))
      rows = patent ? [{ app_number: patent.app_number }] : []
    else if (sql.includes('LEFT JOIN cnipa.history_import_source'))
      rows = patent
        ? [
            {
              ...patent,
              fingerprint: parts.get(values[2] as string),
              ftp_folder: null,
            },
          ]
        : []
    else if (sql.startsWith('INSERT INTO sync_batches'))
      batches.add(values[0] as string)
    else if (sql.startsWith('INSERT INTO cnipa.patent\n')) {
      if (patent) throw new Error('duplicate publication')
      inserts++
      patent = {
        id: 'stable-id',
        pub_date: values[2],
        app_number: values[3],
        title: values[4],
        description: values[6],
        claims: values[7],
        batch_id: values[8],
      }
      rows = [{ id: patent.id }]
    } else if (sql.startsWith('UPDATE cnipa.patent SET title=')) {
      patent!.title = values[1] || patent!.title
      patent!.description = values[3] ?? patent!.description
      patent!.claims = values[4] ?? patent!.claims
      patent!.app_number = values[5] || patent!.app_number
      patent!.pub_date = values[6] || patent!.pub_date
      if (values[10]) patent!.batch_id = values[9]
    } else if (sql.startsWith('UPDATE cnipa.patent SET pub_date=')) {
      patent!.pub_date ||= values[1]
      if (values[3]) patent!.batch_id ||= values[2]
    } else if (sql.includes('description=COALESCE($2::jsonb')) {
      patent!.description = values[1] ?? patent!.description
      patent!.claims = values[2] ?? patent!.claims
    } else if (sql.startsWith('INSERT INTO cnipa.history_import_part'))
      parts.set(values[1] as string, values[2] as string)
    else if (sql.includes(' AS complete'))
      rows = [
        {
          complete: !!(
            patent?.title &&
            patent.pub_date &&
            patent.app_number &&
            patent.description &&
            patent.claims &&
            parts.has('images')
          ),
        },
      ]
    else if (sql.startsWith('SELECT id,oss_key FROM cnipa.image_asset'))
      rows = asset ? [asset] : []
    else if (sql.startsWith('INSERT INTO cnipa.image_asset')) {
      asset = { id: 'shared-asset', oss_key: values[0] as string }
      rows = [{ id: asset.id }]
    } else if (sql.startsWith('DELETE FROM cnipa.patent_image'))
      links.length = 0
    else if (sql.startsWith('INSERT INTO cnipa.patent_image'))
      links.push(values)
    return { rows, rowCount: rows.length }
  })
  const release = vi.fn()
  return {
    pool: { connect: async () => ({ query, release }) } as unknown as pg.Pool,
    query,
    links,
    batches,
    get patent() {
      return patent
    },
    get inserts() {
      return inserts
    },
  }
}

const orders = [
  ['metadata', 'text', 'images'],
  ['metadata', 'images', 'text'],
  ['text', 'metadata', 'images'],
  ['text', 'images', 'metadata'],
  ['images', 'metadata', 'text'],
  ['images', 'text', 'metadata'],
] as const

describe('三类数据任意顺序补齐', () => {
  it.each([false, true])('图片导入从 PDF 日期补齐批次，已有文本=%s', async (textFirst) => {
    const db = database()
    const upload = vi.fn()
    if (textFirst) await publishRecord(db.pool, source('text'), configSchema.parse({stage:'text',columns:{},descriptionPath:'description.parquet'}), 'text-first', upload)
    const manifest: PdfManifest = JSON.parse(await readFile(pdfManifest, 'utf8'))
    manifest.publication_date = '2008-01-01'
    manifest.announcement_batch = 'CN-PA-TXTS-10-B-20080101'
    const file = path.join(path.dirname(pdfManifest), 'dated-manifest.json')
    await writeFile(file, JSON.stringify(manifest))
    await publishRecord(db.pool, {...source('images'),pdfManifest:file}, configSchema.parse({stage:'images',columns:{},pdfPath:'input.zip'}), 'dated-image', upload)
    expect(db.patent?.pub_date).toBe('2008-01-01')
    expect(db.patent?.batch_id).toBe('CN-PA-TXTS-10-B-20080101')
    expect(db.batches.has('CN-PA-TXTS-10-B-20080101')).toBe(true)
    expect(db.inserts).toBe(1)
  })
  it.each(orders.map((order) => [order.join(' → '), order] as const))(
    '%s 保持同一 ID、正文和图片',
    async (_name, order) => {
      const db = database()
      const upload = vi.fn()
      for (const stage of order) {
        const config = configSchema.parse({
          stage,
          columns: {},
          excelPath: 'input.xlsx',
          descriptionPath: 'description.parquet',
          claimsPath: 'claims.parquet',
          pdfPath: 'input.zip',
        })
        await publishRecord(
          db.pool,
          source(stage),
          config,
          `job-${stage}`,
          upload,
        )
        expect(db.patent?.id).toBe('stable-id')
        if (!db.patent?.pub_date) {
          expect(db.batches.size).toBe(0)
          expect(db.patent?.batch_id).toBeNull()
        }
      }
      expect(db.inserts).toBe(1)
      expect(db.patent).toMatchObject({
        id: 'stable-id',
        title: '授权版',
        pub_date: '2008-01-01',
        app_number: 'CN2004100587248',
        batch_id: 'CN-PA-TXTS-10-B-20080101',
        description: JSON.stringify({ embodiment: '说明书正文' }),
        claims: JSON.stringify('权利要求正文'),
      })
      expect(upload).toHaveBeenCalledTimes(1)
      expect(db.links).toHaveLength(2)
      expect(
        db.links.every(
          (link) => link[0] === 'stable-id' && link[1] === 'shared-asset',
        ),
      ).toBe(true)
      // Re-running the same image stage after metadata arrives must not upload or replace links.
      const result = await publishRecord(
        db.pool,
        source('images'),
        configSchema.parse({
          stage: 'images',
          columns: {},
          pdfPath: 'input.zip',
        }),
        'retry',
        upload,
      )
      expect(result.skipped).toBe(true)
      expect(upload).toHaveBeenCalledTimes(1)
      expect(db.links).toHaveLength(2)
    },
  )
})
