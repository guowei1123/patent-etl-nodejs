import { describe, expect, it } from 'vitest'
import {
  dedupePatentsForImport,
  filterRemainingPatentsForImport,
  getPatentImportKey,
} from '../etl/import-step'
import type { ParsedPatent } from '@/types'

function patent(
  patent_number: string,
  patent_type: ParsedPatent['patent_type'],
  kind?: string,
): ParsedPatent {
  return {
    patent_number,
    patent_type,
    kind,
    title: `Patent ${patent_number}`,
  }
}

describe('导入续跑过滤', () => {
  it('uses explicit kind when building the import key', () => {
    expect(getPatentImportKey(patent('100001', 'invention', 'U'))).toBe(
      '100001\u0000U',
    )
  })

  it('falls back to patent type when kind is missing', () => {
    expect(getPatentImportKey(patent('100001', 'invention'))).toBe(
      '100001\u0000B',
    )
    expect(getPatentImportKey(patent('200001', 'utility_model'))).toBe(
      '200001\u0000U',
    )
  })

  it('skips patents already imported for the same batch key', () => {
    const patents = [
      patent('100001', 'invention'),
      patent('100002', 'invention'),
      patent('200001', 'utility_model'),
    ]
    const importedKeys = new Set(['100001\u0000B', '200001\u0000U'])

    expect(filterRemainingPatentsForImport(patents, importedKeys)).toEqual([
      patents[1],
    ])
  })

  it('deduplicates parsed patents by the same import key', () => {
    const first = patent('100001', 'invention')
    const replacement = {
      ...patent('100001', 'invention'),
      title: 'Updated patent 100001',
    }
    const differentKind = patent('100001', 'utility_model', 'U')
    const unique = patent('100002', 'invention')

    expect(
      dedupePatentsForImport([first, differentKind, replacement, unique]),
    ).toEqual([replacement, differentKind, unique])
  })
})
