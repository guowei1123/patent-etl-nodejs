import { describe, expect, it } from 'vitest'
import {
  buildClassificationEmbeddingContent,
  buildClassificationEmbeddingDocument,
  getClassificationDepthLabel,
  hashClassificationEmbeddingContent,
  toPgVectorLiteral,
} from '../classification-embedding'
import type { ClassificationRow } from '@/types'

function classificationRow(
  overrides: Partial<ClassificationRow> = {},
): ClassificationRow {
  return {
    code_norm: 'H01M4/13',
    code: 'H01M 4/13',
    source_code: 'H01M0004130000',
    version: '2026.01',
    section: 'H',
    class_code: 'H01',
    subclass: 'H01M',
    main_group: '4',
    subgroup: '13',
    level: null,
    title_en: 'Electrodes',
    title_zh: '电极',
    title_zh_source: 'cnipa',
    source_file: 'EN_ipc_section_H_title_list_20260101.txt',
    ...overrides,
  }
}

describe('classification embedding helpers', () => {
  it('builds deterministic mixed-language IPC embedding content', () => {
    const row = classificationRow()
    const content = buildClassificationEmbeddingContent(row, 'ipc', 'mixed')

    expect(content).toContain('分类类型：IPC')
    expect(content).toContain('分类号：H01M 4/13')
    expect(content).toContain('中文标题：电极')
    expect(content).toContain('英文标题：Electrodes')
    expect(content).toContain(
      '结构字段：section=H class=H01 subclass=H01M main_group=4 subgroup=13',
    )
    expect(buildClassificationEmbeddingDocument('ipc', row).content_hash).toBe(
      hashClassificationEmbeddingContent(content),
    )
  })

  it('honors locale when selecting title text', () => {
    const row = classificationRow()
    const zhContent = buildClassificationEmbeddingContent(row, 'ipc', 'zh')
    const enContent = buildClassificationEmbeddingContent(row, 'ipc', 'en')

    expect(zhContent).toContain('中文标题：电极')
    expect(zhContent).not.toContain('英文标题：Electrodes')
    expect(enContent).not.toContain('中文标题：电极')
    expect(enContent).toContain('英文标题：Electrodes')
  })

  it('labels hierarchy depth for broad and concrete rows', () => {
    expect(getClassificationDepthLabel(classificationRow())).toBe('subgroup')
    expect(
      getClassificationDepthLabel(
        classificationRow({ subgroup: '00', main_group: '4' }),
      ),
    ).toBe('main_group')
    expect(
      getClassificationDepthLabel(
        classificationRow({ subgroup: null, main_group: null }),
      ),
    ).toBe('subclass')
  })

  it('serializes finite embeddings as pgvector literals', () => {
    expect(toPgVectorLiteral([0.1, -0.2, 3])).toBe('[0.1,-0.2,3]')
    expect(() => toPgVectorLiteral([])).toThrow(
      'Embedding vector cannot be empty',
    )
    expect(() => toPgVectorLiteral([Number.NaN])).toThrow(
      'Embedding vector contains a non-finite value',
    )
  })
})
