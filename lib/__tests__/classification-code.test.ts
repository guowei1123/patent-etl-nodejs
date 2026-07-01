import { describe, expect, it } from 'vitest'
import {
  getClassificationAncestorCodeNorms,
  getClassificationDepth,
  getClassificationParentCodeNorm,
  ipcWipoLongToDisplayCode,
  normalizeCpcClassificationCode,
  normalizeIpcClassificationCode,
  splitClassificationCode,
} from '../classification-code'

describe('classification code normalization', () => {
  it('converts WIPO IPC long format to display and normalized codes', () => {
    expect(ipcWipoLongToDisplayCode('H01B0001000000')).toBe('H01B 1/00')
    expect(ipcWipoLongToDisplayCode('H01M0004130000')).toBe('H01M 4/13')
    expect(ipcWipoLongToDisplayCode('H04L0065101600')).toBe('H04L 65/1016')

    expect(normalizeIpcClassificationCode('H01B0001000000')).toMatchObject({
      code: 'H01B 1/00',
      code_norm: 'H01B1/00',
      section: 'H',
      class_code: 'H01',
      subclass: 'H01B',
      main_group: '1',
      subgroup: '00',
    })
  })

  it('normalizes regular IPC and CPC group formats', () => {
    expect(normalizeIpcClassificationCode('H01B 1/00')).toMatchObject({
      code: 'H01B 1/00',
      code_norm: 'H01B1/00',
    })

    expect(normalizeCpcClassificationCode('h01b1/023 (2026.05)')).toMatchObject(
      {
        code: 'H01B 1/023',
        code_norm: 'H01B1/023',
        main_group: '1',
        subgroup: '023',
      },
    )
  })

  it('splits hierarchy rows without group data', () => {
    expect(splitClassificationCode('H')).toEqual({
      section: 'H',
      class_code: null,
      subclass: null,
      main_group: null,
      subgroup: null,
    })
    expect(splitClassificationCode('H01')).toMatchObject({
      section: 'H',
      class_code: 'H01',
      subclass: null,
    })
    expect(splitClassificationCode('H01M')).toMatchObject({
      section: 'H',
      class_code: 'H01',
      subclass: 'H01M',
    })
  })

  it('keeps CPC Y-section codes and H04L deep subgroup samples', () => {
    expect(normalizeCpcClassificationCode('Y02A20/108')).toMatchObject({
      code: 'Y02A 20/108',
      code_norm: 'Y02A20/108',
      section: 'Y',
      class_code: 'Y02',
      subclass: 'Y02A',
      main_group: '20',
      subgroup: '108',
    })

    expect(normalizeIpcClassificationCode('H04L0065101600')).toMatchObject({
      code: 'H04L 65/1016',
      code_norm: 'H04L65/1016',
      subclass: 'H04L',
      main_group: '65',
      subgroup: '1016',
    })
  })

  it('derives tree parents and depths from normalized code structure', () => {
    expect(getClassificationParentCodeNorm('H')).toBeNull()
    expect(getClassificationParentCodeNorm('H01')).toBe('H')
    expect(getClassificationParentCodeNorm('H01B')).toBe('H01')
    expect(getClassificationParentCodeNorm('H01B 1/00')).toBe('H01B')
    expect(getClassificationParentCodeNorm('H01B 1/02')).toBe('H01B1/00')

    expect(getClassificationDepth('H')).toBe(0)
    expect(getClassificationDepth('H01')).toBe(1)
    expect(getClassificationDepth('H01B')).toBe(2)
    expect(getClassificationDepth('H01B 1/00')).toBe(3)
    expect(getClassificationDepth('H01B 1/02')).toBe(4)

    expect(getClassificationAncestorCodeNorms('Y02A20/108')).toEqual([
      'Y',
      'Y02',
      'Y02A',
      'Y02A20/00',
    ])
  })
})
