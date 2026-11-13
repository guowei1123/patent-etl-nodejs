import { describe, expect, it, vi } from 'vitest'
import type pg from 'pg'

const spawn=vi.hoisted(()=>vi.fn())
vi.mock('node:child_process',()=>({spawn}))
import { finalizeRepairs } from '../pdf/repair-finalize'

describe('批量 Excel 同步校验',()=>{
  it('附图关联发生变化时拒绝写 Excel 和清理 PDF',async()=>{
    const pool={query:vi.fn(async()=>({rows:[]}))} as unknown as pg.Pool
    await expect(finalizeRepairs(pool,['CN1234567B'],{expected:[{number:'CN1234567B',batch:'batch'}]})).rejects.toThrow('附图关联已变化')
    expect(spawn).not.toHaveBeenCalled()
  })
})
