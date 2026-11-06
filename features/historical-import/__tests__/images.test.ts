import { describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { execFileSync } from 'node:child_process'
import { publishImages } from '../images'
import type { PdfManifest } from '../pdf/historical-pdf'

async function fixture(differentSize = false) {
  const svg =
    '<svg width="200" height="200"><rect width="200" height="200" fill="white"/><rect x="30" y="40" width="120" height="100" stroke="black" fill="none" stroke-width="4"/><path d="M30 40 L150 140" stroke="black" stroke-width="4"/></svg>'
  const drawing = await sharp(Buffer.from(svg)).png().toBuffer()
  const abstract = differentSize
    ? await sharp(drawing).resize(140, 140).png().toBuffer()
    : drawing
  const contents = [abstract, drawing]
  const manifest: PdfManifest = {
    version: 'pdf-figures-v2',
    batch: 'HISTORY',
    patent_number: 'CN1577321B',
    pdf_hash: 'a'.repeat(64),
    source: 'fixture',
    images: contents.map((content, index) => ({
      file_name: `CN1577321B_${index === 0 ? 'abstract' : 'drawing'}_001.png`,
      page: index + 1,
      width: 200,
      height: 200,
      content_hash: createHash('sha256').update(content).digest('hex'),
      image_role: index === 0 ? 'abstract' : 'drawing',
      figure_label: '图1',
    })),
  }
  return { manifest, contents }
}
describe('复用摘要附图匹配器', () => {
  it('相同摘要与说明书图只上传一个对象，保留两个用途关联', async () => {
    const { manifest, contents } = await fixture()
    const query = vi.fn(async (sql: string) => ({
      rows: sql.startsWith('INSERT INTO cnipa.image_asset')
        ? [{ id: 'asset' }]
        : [],
      rowCount: 0,
    }))
    const upload = vi.fn()
    await publishImages(
      { query } as unknown as pg.PoolClient,
      'patent',
      'HIST-20080101-B',
      manifest,
      contents,
      upload,
      'job',
    )
    expect(upload).toHaveBeenCalledTimes(1)
    const links = query.mock.calls.filter(([sql]) =>
      sql.startsWith('INSERT INTO cnipa.patent_image'),
    )
    expect(links).toHaveLength(2)
    // Read actual query values via the complete mock call representation.
    const calls = query.mock.calls as unknown as Array<[string, unknown[]]>
    const values = calls
      .filter(([sql]) => sql.startsWith('INSERT INTO cnipa.patent_image'))
      .map(([, args]) => args)
    expect(values[0][1]).toBe(values[1][1])
    expect(values[0][3]).toBe(values[1][3])
    expect(values.map((args) => args[8])).toEqual(['abstract', 'drawing'])
    expect(String(upload.mock.calls[0][0])).toBe(
      `patents/HIST-20080101-B/1577321/${manifest.images[1].file_name}`,
    )
  })
  it('正文表格保留用途，不伪装为附图或用于摘要视觉匹配', async () => {
    const { manifest, contents } = await fixture()
    manifest.images[1].image_role = 'table'
    manifest.images[1].file_name = 'CN1577321B_table_001.png'
    const query = vi.fn(async (sql: string) => ({
      rows: sql.startsWith('INSERT INTO cnipa.image_asset')
        ? [{ id: 'asset' }]
        : [],
    }))
    await publishImages(
      { query } as unknown as pg.PoolClient,
      'patent',
      'batch',
      manifest,
      contents,
      vi.fn(),
      'job',
    )
    const calls = query.mock.calls as unknown as Array<[string, unknown[]]>
    expect(
      calls
        .filter(([sql]) => sql.startsWith('INSERT INTO cnipa.patent_image'))
        .map(([, args]) => args[8]),
    ).toEqual(['abstract', 'table'])
  })
  it('不同尺寸的同图通过现有结构匹配算法复用说明书图', async () => {
    const { manifest, contents } = await fixture(true)
    // The shared matcher's dynamic Sharp loader must run in the actual Node worker runtime.
    const script = `import { readFileSync } from 'node:fs'; import { imageAssetPlan } from './features/historical-import/images.ts';
      const input=JSON.parse(readFileSync(0,'utf8')); const plan=await imageAssetPlan(input.manifest,input.contents.map(c=>Buffer.from(c,'base64')));
      process.stdout.write(JSON.stringify(plan));`
    const plan = JSON.parse(
      execFileSync(
        process.execPath,
        ['--experimental-strip-types', '--input-type=module', '-e', script],
        {
          input: JSON.stringify({
            manifest,
            contents: contents.map((c) => c.toString('base64')),
          }),
          windowsHide: true,
          encoding: 'utf8',
          timeout: 15000,
        },
      ),
    )
    expect(plan[0].canonical).toBe(1)
    expect(plan[0].method).toBe('hash-top5-binary-structure')
  })
  it('数据库已有相同 SHA 图片时无需再次上传', async () => {
    const { manifest, contents } = await fixture()
    const query = vi.fn(async (sql: string) => ({
      rows: sql.startsWith('SELECT id,oss_key')
        ? [{ id: 'existing', oss_key: 'patents/existing.png' }]
        : [],
      rowCount: 0,
    }))
    const upload = vi.fn()
    await publishImages(
      { query } as unknown as pg.PoolClient,
      'patent',
      'HIST-20080101-B',
      manifest,
      contents,
      upload,
      'job',
    )
    expect(upload).not.toHaveBeenCalled()
    expect(
      query.mock.calls.some(([sql]) =>
        sql.startsWith('INSERT INTO cnipa.image_asset'),
      ),
    ).toBe(false)
  })
  it('上传失败前不删除原有图片关联', async () => {
    const { manifest, contents } = await fixture()
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    await expect(
      publishImages(
        { query } as unknown as pg.PoolClient,
        'patent',
        'batch',
        manifest,
        contents,
        vi.fn().mockRejectedValue(new Error('failed')),
        'job',
      ),
    ).rejects.toThrow()
    expect(
      (query.mock.calls as unknown as Array<[string]>).some(([sql]) =>
        sql.startsWith('DELETE'),
      ),
    ).toBe(false)
  })

  it('同一简化路径存在不同内容时不覆盖对象', async () => {
    const { manifest, contents } = await fixture()
    const query = vi.fn(async (sql: string) => ({ rows: sql.startsWith('SELECT id FROM cnipa.image_asset WHERE oss_key=') ? [{ id: 'conflict' }] : [] }))
    const upload = vi.fn()
    await expect(publishImages({ query } as unknown as pg.PoolClient, 'patent', 'batch', manifest, contents, upload, 'job')).rejects.toThrow('同名图片已有不同内容')
    expect(upload).not.toHaveBeenCalled()
  })
})
