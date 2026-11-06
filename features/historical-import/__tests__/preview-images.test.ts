import { describe, expect, it, vi } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
const mocks = vi.hoisted(() => ({ getJob: vi.fn(), jobDirectory: vi.fn() }))
vi.mock('../jobs', () => mocks)
import { previewImages } from '../preview-images'

describe('附图预览', () => {
  it('预览显示两个用途和一个资源，并拒绝任意文件读取', async () => {
    const root = path.resolve('data/historical-import/validation/image-preview')
    await mkdir(root, { recursive: true })
    const content = await sharp({
      create: { width: 100, height: 100, channels: 3, background: '#ffffff' },
    })
      .png()
      .toBuffer()
    const names = ['CN1577321B_drawing_001.png', 'CN1577321B_abstract_001.png']
    for (const name of names) await writeFile(path.join(root, name), content)
    const manifest = path.join(root, 'manifest.json')
    await writeFile(
      manifest,
      JSON.stringify({
        version: 'pdf-figures-v2',
        batch: 'HISTORY',
        patent_number: 'CN1577321B',
        pdf_hash: 'a'.repeat(64),
        source: 'fixture',
        images: names.map((file_name, index) => ({
          file_name,
          page: 1,
          width: 100,
          height: 100,
          content_hash: createHash('sha256').update(content).digest('hex'),
          figure_label: '图1',
          image_role: index ? 'abstract' : 'drawing',
        })),
      }),
    )
    mocks.getJob.mockResolvedValue({
      sample: [{ publication: 'CN1577321B', pdfManifest: manifest }],
    })
    mocks.jobDirectory.mockReturnValue(root)
    const result = await previewImages('job', 'CN1577321B')
    expect(result.data?.uniqueImages).toBe(1)
    expect(result.data?.images).toHaveLength(2)
    expect(
      (await previewImages('job', 'CN1577321B', names[0])).content,
    ).toEqual(content)
    await expect(previewImages('job', 'CN1577321B', '../.env')).rejects.toThrow(
      '附图文件无效',
    )
  })
  it('拒绝跨任务目录的清单', async () => {
    const root = path.resolve('data/historical-import/validation/image-preview')
    const outside = path.resolve(
      'data/historical-import/validation/outside-preview.json',
    )
    await mkdir(root, { recursive: true })
    await writeFile(outside, '{}')
    mocks.getJob.mockResolvedValue({
      sample: [{ publication: 'CN1577321B', pdfManifest: outside }],
    })
    mocks.jobDirectory.mockReturnValue(root)
    await expect(previewImages('job', 'CN1577321B')).rejects.toThrow(
      '附图路径无效',
    )
  })
})
