import { describe, expect, it } from 'vitest'
import {
  buildPatentSearchExpressionCondition,
  PatentSearchExpressionError,
} from '../patent-search-expression'

describe('patent search expression', () => {
  it('builds parameterized SQL for fielded boolean expressions', () => {
    const condition = buildPatentSearchExpressionCondition(
      'TI:"新能源" AND PA:比亚迪 NOT IPC:H01M',
      3,
    )

    expect(condition?.sql).toContain('p.title ILIKE $3')
    expect(condition?.sql).toContain('pa_expr.name ILIKE $4')
    expect(condition?.sql).toContain('NOT (')
    expect(condition?.sql).toContain('pic_expr.ipc_code ILIKE $5')
    expect(condition?.params).toEqual(['%新能源%', '%比亚迪%', '%H01M%'])
    expect(condition?.nextParamIndex).toBe(6)
  })

  it('applies a field to grouped terms', () => {
    const condition = buildPatentSearchExpressionCondition(
      'PA:(华为 OR 腾讯)',
      1,
    )

    expect(condition?.sql).toContain('pa_expr.name ILIKE $1')
    expect(condition?.sql).toContain('OR')
    expect(condition?.sql).toContain('pa_expr.name ILIKE $2')
    expect(condition?.params).toEqual(['%华为%', '%腾讯%'])
  })

  it('treats adjacent terms as implicit AND', () => {
    const condition = buildPatentSearchExpressionCondition('新能源 电池', 1)

    expect(condition?.sql).toContain(') AND (')
    expect(condition?.params).toEqual(['%新能源%', '%电池%'])
  })

  it('builds year ranges for publication date fields', () => {
    const condition = buildPatentSearchExpressionCondition('公开日:2024', 2)

    expect(condition?.sql).toContain('p.pub_date >= $2')
    expect(condition?.sql).toContain('p.pub_date < $3')
    expect(condition?.params).toEqual(['2024-01-01', '2025-01-01'])
    expect(condition?.nextParamIndex).toBe(4)
  })

  it('rejects invalid publication dates', () => {
    expect(() =>
      buildPatentSearchExpressionCondition('公开日:2024-02-31', 1),
    ).toThrow('公开日字段日期格式不合法')
  })

  it('rejects unsupported field names', () => {
    expect(() =>
      buildPatentSearchExpressionCondition('TITL:新能源', 1),
    ).toThrow('不支持的检索字段: TITL')
  })

  it('rejects incomplete syntax', () => {
    expect(() =>
      buildPatentSearchExpressionCondition('TI:(新能源 AND', 1),
    ).toThrow(PatentSearchExpressionError)
  })
})
